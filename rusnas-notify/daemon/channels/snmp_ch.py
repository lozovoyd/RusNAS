#!/usr/bin/env python3
"""SNMP trap delivery channel."""

import logging
import subprocess

logger = logging.getLogger("rusnas-notify.ch.snmp")

# rusNAS enterprise OID
ENTERPRISE_OID = ".1.3.6.1.4.1.99999"
SEVERITY_MAP = {"critical": "2", "warning": "1", "info": "0"}


def send(channel_cfg, source, severity, title, body, extra_json=None):
    """Send SNMPv2c/v3 trap to all receivers."""
    receivers = channel_cfg.get("trap_receivers", [])
    version = channel_cfg.get("version", "v2c")

    if not receivers:
        return False, "No trap receivers configured"

    errors = []
    for receiver in receivers:
        host_port = receiver if ":" in receiver else receiver + ":162"
        try:
            if version == "v2c":
                community = channel_cfg.get("community", "public")
                cmd = [
                    "snmptrap", "-v", "2c", "-c", community,
                    host_port, "", ENTERPRISE_OID,
                    ENTERPRISE_OID + ".1", "s", source,
                    ENTERPRISE_OID + ".2", "s", severity,
                    ENTERPRISE_OID + ".3", "s", title,
                    ENTERPRISE_OID + ".4", "s", body or "",
                ]
            else:
                cmd = [
                    "snmptrap", "-v", "3",
                    "-u", channel_cfg.get("v3_username", ""),
                    "-l", "authPriv",
                    "-a", channel_cfg.get("v3_auth_protocol", "SHA"),
                    "-A", channel_cfg.get("v3_auth_password", ""),
                    "-x", channel_cfg.get("v3_priv_protocol", "AES"),
                    "-X", channel_cfg.get("v3_priv_password", ""),
                    host_port, "", ENTERPRISE_OID,
                    ENTERPRISE_OID + ".1", "s", source,
                    ENTERPRISE_OID + ".2", "s", severity,
                    ENTERPRISE_OID + ".3", "s", title,
                    ENTERPRISE_OID + ".4", "s", body or "",
                ]
            subprocess.run(cmd, check=True, capture_output=True, timeout=10)
            logger.info("SNMP trap sent to %s", host_port)
        except FileNotFoundError:
            errors.append("%s: snmptrap not installed (apt install snmp)" % host_port)
        except Exception as e:
            errors.append("%s: %s" % (host_port, e))
            logger.error("SNMP trap to %s failed: %s", host_port, e)

    if errors:
        return False, "; ".join(errors)
    return True, None


def test(channel_cfg):
    return send(
        channel_cfg, "test", "info",
        "rusNAS test trap",
        "This is a test SNMP trap from rusNAS."
    )
