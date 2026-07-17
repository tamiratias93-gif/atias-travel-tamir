/**
 * Atias Travel — Gemini proxy (Google Apps Script Web App).
 * Keeps the API key hidden: the website calls THIS url, never Google directly.
 *
 * SETUP (one time):
 *  1. script.google.com → New project → paste this file.
 *  2. Project Settings (gear) → Script Properties → Add:
 *        GEMINI_KEY = <the key from AI Studio>
 *  3. Deploy → New deployment → type "Web app":
 *        Execute as: Me
 *        Who has access: Anyone
 *     → Deploy → Authorize → copy the /exec URL.
 *  4. Put that /exec URL in the site's config.js as GEMINI_PROXY_URL.
 */

var MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-3-flash-preview'];
var TAMIR_EMAIL = 'tamiratias93@gmail.com';

function doPost(e) {
  var out = ContentService.createTextOutput();
  out.setMimeType(ContentService.MimeType.JSON);
  try {
    var payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // ---- Lead from the website: email the collected details straight to Tamir ----
    if (payload.type === 'lead') {
      return out.setContent(JSON.stringify(handleLead(payload)));
    }

    var key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
    if (!key) return out.setContent(JSON.stringify({ error: 'no key configured' }));

    var body = {
      system_instruction: payload.system_instruction,
      contents: payload.contents,
      generationConfig: payload.generationConfig || { temperature: 0.7, maxOutputTokens: 1400 }
    };

    var lastErr = 'unavailable';
    for (var m = 0; m < MODELS.length; m++) {
      for (var attempt = 0; attempt < 2; attempt++) {
        var resp = UrlFetchApp.fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/' + MODELS[m] + ':generateContent?key=' + key,
          { method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true }
        );
        var code = resp.getResponseCode();
        if (code === 429 || code === 503) { lastErr = MODELS[m] + ' ' + code; Utilities.sleep(700); continue; }
        if (code !== 200) { lastErr = MODELS[m] + ' ' + code; break; }
        var data = JSON.parse(resp.getContentText());
        var parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
        var txt = parts.map(function (p) { return p.text || ''; }).join('').trim();
        if (txt) return out.setContent(JSON.stringify({ text: txt }));
        lastErr = MODELS[m] + ' empty';
      }
    }
    return out.setContent(JSON.stringify({ error: lastErr }));
  } catch (err) {
    return out.setContent(JSON.stringify({ error: String(err) }));
  }
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ status: 'Atias Travel proxy is running' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this ONCE from the editor after pasting the new code.
 * It triggers Google's permission prompt for sending email, and sends a
 * confirmation to Tamir so we know leads will arrive.
 */
function _authorizeMail() {
  MailApp.sendEmail(TAMIR_EMAIL, 'הסוכן של Atias Travel — הכל מוכן ✅',
    'מעולה! מעכשיו בכל פעם שלקוח משאיר פרטים בסוכן החכם באתר, הם יגיעו ישירות למייל הזה.');
}

/**
 * Emails a new website lead to Tamir. Runs as Tamir (Execute as: Me),
 * so the mail is sent from his own Gmail — no extra service needed.
 */
function handleLead(payload) {
  try {
    var L = payload.lead || {};
    var labels = {
      dest: 'יעד', dates: 'תאריכים / עונה', travelers: 'מי נוסע',
      interests: 'תחומי עניין', needs: 'צרכים מיוחדים', budget: 'תקציב', contact: 'פרטי קשר'
    };
    var lines = [];
    Object.keys(labels).forEach(function (k) {
      if (L[k]) lines.push(labels[k] + ': ' + L[k]);
    });

    var dest = L.dest || 'לא צוין';
    var subject = 'ליד חדש מהאתר — ' + dest + (L.contact ? ' (' + L.contact + ')' : '');
    var bodyText =
      'ליד חדש הגיע מהסוכן החכם באתר.\n\n' +
      '== סיכום הפרטים ==\n' +
      (lines.length ? lines.join('\n') : '(לא נאספו שדות מובנים)') +
      '\n\n== שיחת הלקוח המלאה ==\n' +
      (payload.transcript || '(אין תמלול)') +
      '\n\n----\nמקור: ' + (payload.page || 'האתר') +
      '\nנשלח אוטומטית ממערכת הסוכן.';

    MailApp.sendEmail({ to: TAMIR_EMAIL, subject: subject, body: bodyText });
    return { ok: true };
  } catch (err) {
    return { error: 'lead: ' + String(err) };
  }
}
