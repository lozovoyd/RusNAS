"""Channel registry — maps channel name to send function."""

from . import email_ch, telegram_ch, max_ch, snmp_ch, webhook_ch

CHANNELS = {
    "email":    email_ch.send,
    "telegram": telegram_ch.send,
    "max":      max_ch.send,
    "snmp":     snmp_ch.send,
    "webhook":  webhook_ch.send,
}

TEST_CHANNELS = {
    "email":    email_ch.test,
    "telegram": telegram_ch.test,
    "max":      max_ch.test,
    "snmp":     snmp_ch.test,
    "webhook":  webhook_ch.test,
}
