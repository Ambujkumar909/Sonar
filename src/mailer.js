// =============================================================
//  Sonar — email sender for the daily report (nodemailer/SMTP).
//  Reads SMTP settings from config (EMAIL_*/SMTP_* in .env).
//  isConfigured() is false when host/user/pass aren't all set —
//  in that case the report is still generated & saved, just not sent.
// =============================================================
const nodemailer = require('nodemailer')
const cfg = require('./config')

const isConfigured = () => !!(cfg.SMTP.host && cfg.SMTP.user && cfg.SMTP.pass)

let _transport = null
function transport() {
  if (_transport) return _transport
  _transport = nodemailer.createTransport({
    host: cfg.SMTP.host,
    port: cfg.SMTP.port,
    secure: cfg.SMTP.secure, // true for 465, false for 587 (STARTTLS)
    auth: { user: cfg.SMTP.user, pass: cfg.SMTP.pass },
  })
  return _transport
}

// Verify SMTP credentials/connection (used by the "send test"/status checks).
async function verify() {
  if (!isConfigured()) throw new Error('SMTP is not configured (set EMAIL_HOST/EMAIL_USER/EMAIL_PASS in .env)')
  return transport().verify()
}

// Send the report. attachmentHtml is the full report document; bodyHtml is the
// short summary shown in the email body. to = array of addresses.
async function sendReport({ to, subject, bodyHtml, attachmentHtml, filename }) {
  if (!isConfigured()) throw new Error('SMTP is not configured')
  if (!to || !to.length) throw new Error('No recipients')
  return transport().sendMail({
    from: cfg.SMTP.from,
    to: to.join(', '),
    subject,
    html: bodyHtml,
    attachments: attachmentHtml ? [{ filename: filename || 'report.html', content: attachmentHtml, contentType: 'text/html' }] : [],
  })
}

module.exports = { isConfigured, verify, sendReport, from: () => cfg.SMTP.from }
