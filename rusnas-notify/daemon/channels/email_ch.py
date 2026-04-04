#!/usr/bin/env python3
"""Email (SMTP) delivery channel."""

import logging
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

logger = logging.getLogger("rusnas-notify.ch.email")

SEVERITY_COLORS = {
    "critical": "#dc2626",
    "warning":  "#d97706",
    "info":     "#2563eb",
}


def send(channel_cfg, source, severity, title, body, extra_json=None):
    """Send notification email. Returns (ok, error_msg)."""
    host = channel_cfg.get("smtp_host", "")
    port = channel_cfg.get("smtp_port", 587)
    tls_mode = channel_cfg.get("smtp_tls", "starttls")
    user = channel_cfg.get("smtp_user", "")
    password = channel_cfg.get("smtp_pass", "")
    recipients = channel_cfg.get("recipients", [])
    from_addr = channel_cfg.get("from", "rusNAS <noreply@localhost>")

    if not host or not recipients:
        return False, "SMTP host or recipients not configured"

    subject = "[rusNAS] [%s] %s: %s" % (severity.upper(), source.capitalize(), title)
    color = SEVERITY_COLORS.get(severity, "#2563eb")

    html = (
        '<div style="font-family:sans-serif;max-width:600px">'
        '<div style="background:%s;color:white;padding:12px 16px;border-radius:8px 8px 0 0">'
        '<strong>%s</strong></div>'
        '<div style="background:#f8fafc;padding:16px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">'
        '<p><strong>%s</strong></p>'
        '<p style="color:#475569">%s</p>'
        '<hr style="border:none;border-top:1px solid #e2e8f0">'
        '<small style="color:#94a3b8">rusNAS Notification System</small>'
        '</div></div>'
    ) % (color, subject, title, body or "")

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = ", ".join(recipients)
    msg.attach(MIMEText(body or title, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))

    try:
        if tls_mode == "ssl":
            server = smtplib.SMTP_SSL(host, port, timeout=15)
        else:
            server = smtplib.SMTP(host, port, timeout=15)
            if tls_mode == "starttls":
                server.starttls()
        if user:
            server.login(user, password)
        server.sendmail(from_addr, recipients, msg.as_string())
        server.quit()
        logger.info("Email sent to %s", recipients)
        return True, None
    except Exception as e:
        logger.error("Email send failed: %s", e)
        return False, str(e)


def test(channel_cfg):
    """Send test email. Returns (ok, error_msg)."""
    return send(
        channel_cfg, "test", "info",
        "Тестовое уведомление / Test notification",
        "Это тестовое уведомление от rusNAS.\nThis is a test notification from rusNAS."
    )
