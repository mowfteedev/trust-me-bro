"""Telemetry fixture/schema checks; Gateway validation is exercised by make test/e2e."""
import copy
import json
import math
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class SchemaValidator:
    """Validate the JSON Schema subset used by telemetry.schema.json, without dependencies."""

    def __init__(self, schema):
        self.schema = schema

    def validate(self, payload):
        errors = []
        self._validate(self.schema, payload, '$', errors)
        return errors

    def _validate(self, schema, value, path, errors):
        kind = schema.get('type')
        valid = {'object': isinstance(value, dict), 'array': isinstance(value, list),
                 'string': isinstance(value, str), 'integer': type(value) is int,
                 'number': type(value) is int or (type(value) is float and math.isfinite(value))}
        if kind not in valid or not valid[kind]:
            errors.append(f'{path}: expected {kind}')
            return
        if kind == 'object':
            properties = schema.get('properties', {})
            for required in schema.get('required', []):
                if required not in value:
                    errors.append(f'{path}: missing {required}')
            for key, item in value.items():
                if key in properties:
                    self._validate(properties[key], item, f'{path}.{key}', errors)
                elif schema.get('additionalProperties') is False:
                    errors.append(f'{path}: unexpected {key}')
        elif kind == 'array':
            if not schema.get('minItems', 0) <= len(value) <= schema.get('maxItems', math.inf):
                errors.append(f'{path}: invalid array length')
            for index, item in enumerate(value):
                self._validate(schema['items'], item, f'{path}[{index}]', errors)
        elif kind in ('integer', 'number'):
            if not schema.get('minimum', -math.inf) <= value <= schema.get('maximum', math.inf):
                errors.append(f'{path}: out of range')
        elif kind == 'string' and 'pattern' in schema and not re.search(schema['pattern'], value):
            errors.append(f'{path}: invalid format')


class TelemetryContractTests(unittest.TestCase):
    def setUp(self):
        self.validator = SchemaValidator(json.loads((ROOT / 'contracts/telemetry.schema.json').read_text()))
        self.payload = {'node_id': 'node-contract-01', 'timestamp': 1800000000000, 'metrics': {
            'cpu': {'percent': 12.5}, 'memory': {'total_bytes': 1000, 'used_bytes': 400, 'percent': 40},
            'disk': {'total_bytes': 2000, 'used_bytes': 1000, 'percent': 50},
            'network': {'rx_bytes_total': 123, 'tx_bytes_total': 456}, 'uptime_seconds': 789}}

    def test_windows_and_linux_payload_shapes(self):
        self.assertEqual(self.validator.validate(self.payload), [])
        self.payload['metrics']['cpu']['load_avg'] = [0.1, 0.2, 0.3]
        self.assertEqual(self.validator.validate(self.payload), [])

    def test_invalid_values_and_nested_extra_fields(self):
        cases = [(['node_id'], 'bad id!'), (['timestamp'], '1800000000000'), (['timestamp'], 1),
                 (['metrics', 'cpu', 'percent'], -1), (['metrics', 'cpu', 'percent'], 101),
                 (['metrics', 'cpu', 'percent'], True), (['metrics', 'cpu', 'percent'], float('nan')),
                 (['metrics', 'cpu', 'load_avg'], [0, 0]), (['metrics', 'cpu', 'load_avg'], [0, -1, 0]),
                 (['metrics', 'memory', 'total_bytes'], 0), (['metrics', 'memory', 'used_bytes'], -1),
                 (['metrics', 'disk', 'percent'], 101), (['metrics', 'network', 'rx_bytes_total'], -1),
                 (['metrics', 'network'], []), (['metrics', 'memory', 'used_bytes'], '400'),
                 (['metrics', 'uptime_seconds'], -1), (['extra'], 1), (['metrics', 'cpu', 'extra'], 1)]
        for keys, value in cases:
            with self.subTest(keys=keys, value=value):
                payload = copy.deepcopy(self.payload)
                target = payload
                for key in keys[:-1]:
                    target = target[key]
                target[keys[-1]] = value
                self.assertTrue(self.validator.validate(payload))

    def test_required_fields_at_every_object_level(self):
        for path in ([], ['metrics'], ['metrics', 'cpu'], ['metrics', 'memory'],
                     ['metrics', 'disk'], ['metrics', 'network']):
            schema = self.validator.schema
            for key in path:
                schema = schema['properties'][key]
            for required in schema['required']:
                with self.subTest(path=path, required=required):
                    payload = copy.deepcopy(self.payload)
                    target = payload
                    for key in path:
                        target = target[key]
                    del target[required]
                    self.assertTrue(self.validator.validate(payload))

    def test_openapi_declares_public_routes_and_auth_schemes(self):
        spec = (ROOT / 'contracts/openapi.yaml').read_text()
        routes = set(re.findall(r'^  (/[^:]+):$', spec, re.MULTILINE))
        self.assertTrue({'/api/auth/login', '/api/auth/logout', '/api/nodes', '/api/nodes/{node_id}/history',
                         '/api/telemetry/beacon', '/api/bastion/ticket', '/ws/terminal/{node_id}',
                         '/api/audit/logs'} <= routes)
        self.assertIn('BearerAuth: {type: http, scheme: bearer, bearerFormat: JWT}', spec)
        self.assertIn('NodeTokenAuth: {type: apiKey, in: header, name: X-Node-Token}', spec)


if __name__ == '__main__':
    unittest.main()
