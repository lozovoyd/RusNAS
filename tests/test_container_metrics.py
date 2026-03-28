"""Tests for container Prometheus metrics."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../rusnas-metrics'))
from metrics_server import collect_containers  # noqa

def test_collect_containers_returns_string():
    result = collect_containers()
    assert isinstance(result, str)

def test_collect_containers_has_headers():
    result = collect_containers()
    assert "rusnas_container_count" in result
