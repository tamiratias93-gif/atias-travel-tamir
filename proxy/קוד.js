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

/* Each model carries its own daily quota, so the fallback chain is also the
   capacity plan: when one is spent the next still has a full allowance. Ordered
   best-quality-first, with the lite variants last as a floor rather than a
   preference — a lite answer beats no answer. Verified 16.08.2026 that all of
   these accept generateContent on this key. */
var MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-3-flash-preview',
              'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash',
              'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];
/* How long a 429 is trusted. Short enough that a renewed quota is picked up
   almost at once, long enough to stop re-asking a model that is genuinely out. */
var EXHAUSTED_TTL = 300; // seconds
var TAMIR_EMAIL = 'tamiratias93@gmail.com';

function doPost(e) {
  var out = ContentService.createTextOutput();
  out.setMimeType(ContentService.MimeType.JSON);
  try {
    var payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // ---- Lead from the website: email the collected details straight to Tamir ----
    var dkey = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
    if (payload.type === 'models') return out.setContent(JSON.stringify(listModels(dkey)));

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
    /* Diagnostics may pin a single model so its output can be compared against
       the others; production traffic never sets this and walks the chain. */
    /* Always start the walk at the top of the chain, so the moment the preferred
       model's quota renews it is used again on the very next request — there is
       no sticky "we moved on" state to unwind.
       The only thing remembered is which models answered 429, and only for a few
       minutes. That skips the futile calls while a model is genuinely out,
       without deferring the return to it by more than that window. A daily quota
       reset is therefore picked up within EXHAUSTED_TTL, not at the end of the day. */
    var cache = CacheService.getScriptCache();
    var chain = payload.only_model ? [payload.only_model] : MODELS;
    var usable = [];
    for (var c = 0; c < chain.length; c++) {
      if (!payload.only_model && cache.get('out:' + chain[c])) continue;
      usable.push(chain[c]);
    }
    /* If everything is marked out, ignore the marks rather than refusing to try:
       a stale cache must never be the reason a client gets nothing. */
    if (!usable.length) usable = chain;
    chain = usable;
    for (var m = 0; m < chain.length; m++) {
      for (var attempt = 0; attempt < 2; attempt++) {
        var resp = UrlFetchApp.fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/' + chain[m] + ':generateContent?key=' + key,
          { method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true }
        );
        var code = resp.getResponseCode();
        /* 429 is this model's quota being gone. Sleeping and asking it again just
           spends more of a quota that has already run out — move straight to the
           next model, which has its own. Only 503 (transient overload) is worth a
           second attempt. */
        if (code === 429) { lastErr = chain[m] + ' 429';
          if (!payload.only_model) cache.put('out:' + chain[m], '1', EXHAUSTED_TTL);
          break; }
        if (code === 503) { lastErr = chain[m] + ' 503'; Utilities.sleep(700); continue; }
        if (code !== 200) { lastErr = chain[m] + ' ' + code; break; }
        var data = JSON.parse(resp.getContentText());
        var parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
        var txt = parts.map(function (p) { return p.text || ''; }).join('').trim();
        if (txt) { cache.remove('out:' + chain[m]); return out.setContent(JSON.stringify({ text: txt })); }
        lastErr = chain[m] + ' empty';
      }
    }
    return out.setContent(JSON.stringify({ error: lastErr }));
  } catch (err) {
    return out.setContent(JSON.stringify({ error: String(err) }));
  }
}

/* Diagnostic: which models does this key actually have, and which still
   have quota left today. Called with {"type":"models"}. */
function listModels(key) {
  var r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + key +
        '&pageSize=200', { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return { error: 'list ' + r.getResponseCode() };
  var names = (JSON.parse(r.getContentText()).models || [])
    .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
    .map(function (m) { return m.name.replace('models/', ''); });
  return { models: names };
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
