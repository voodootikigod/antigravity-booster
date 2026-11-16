// Versioned JSON schemas + lightweight draft-07 schema validator for structured
// Antigravity LLM outputs (--output-format json --json-schema).

export function validateJsonSchema(data, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return { valid: true, errors: [] };
  const errors = [];

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((t) => {
      if (t === 'null') return data === null;
      if (t === 'array') return Array.isArray(data);
      if (t === 'object') return data !== null && typeof data === 'object' && !Array.isArray(data);
      if (t === 'integer') return typeof data === 'number' && Number.isInteger(data);
      if (t === 'number') return typeof data === 'number' && !Number.isNaN(data);
      return typeof data === t;
    });
    if (!matches) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data}`);
      return { valid: false, errors };
    }
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(data)) {
      errors.push(`${path}: value ${JSON.stringify(data)} not in enum [${schema.enum.join(', ')}]`);
    }
  }

  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push(`${path}: value ${data} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push(`${path}: value ${data} > maximum ${schema.maximum}`);
    }
  }

  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push(`${path}: length ${data.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      errors.push(`${path}: length ${data.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined) {
      try {
        const re = new RegExp(schema.pattern);
        if (!re.test(data)) {
          errors.push(`${path}: value does not match pattern ${schema.pattern}`);
        }
      } catch {}
    }
  }

  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push(`${path}: items count ${data.length} < minItems ${schema.minItems}`);
    }
    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        const itemRes = validateJsonSchema(data[i], schema.items, `${path}[${i}]`);
        if (!itemRes.valid) errors.push(...itemRes.errors);
      }
    }
  }

  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (data[req] === undefined) {
          errors.push(`${path}: missing required property '${req}'`);
        }
      }
    }
    if (schema.properties) {
      for (const [prop, propSchema] of Object.entries(schema.properties)) {
        if (data[prop] !== undefined) {
          const propRes = validateJsonSchema(data[prop], propSchema, `${path}.${prop}`);
          if (!propRes.valid) errors.push(...propRes.errors);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) {
          errors.push(`${path}: unauthorized additional property '${key}'`);
        }
      }
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const anyMatches = schema.anyOf.some((sub) => validateJsonSchema(data, sub, path).valid);
    if (!anyMatches) {
      errors.push(`${path}: does not match anyOf schemas`);
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const oneMatches = schema.oneOf.filter((sub) => validateJsonSchema(data, sub, path).valid);
    if (oneMatches.length !== 1) {
      errors.push(`${path}: expected exactly one matching oneOf schema, matched ${oneMatches.length}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export const QUOTA_RESPONSE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['gemini', 'claude_gpt'],
  properties: {
    gemini: {
      type: 'object',
      additionalProperties: false,
      required: ['fiveHourRemainingPercent', 'weeklyRemainingPercent', 'fiveHourResetTime', 'weeklyResetTime'],
      properties: {
        fiveHourRemainingPercent: { type: 'number', minimum: 0.0, maximum: 100.0 },
        weeklyRemainingPercent: { type: 'number', minimum: 0.0, maximum: 100.0 },
        fiveHourResetTime: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
        },
        weeklyResetTime: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
        },
      },
    },
    claude_gpt: {
      type: 'object',
      additionalProperties: false,
      required: ['fiveHourRemainingPercent', 'weeklyRemainingPercent', 'fiveHourResetTime', 'weeklyResetTime'],
      properties: {
        fiveHourRemainingPercent: { type: 'number', minimum: 0.0, maximum: 100.0 },
        weeklyRemainingPercent: { type: 'number', minimum: 0.0, maximum: 100.0 },
        fiveHourResetTime: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
        },
        weeklyResetTime: {
          type: 'string',
          format: 'date-time',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
        },
      },
    },
  },
};

export const STREAM_EVENT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  oneOf: [
    {
      additionalProperties: false,
      required: ['type', 'step', 'action'],
      properties: {
        type: { type: 'string', enum: ['step_update'] },
        step: { type: 'integer', minimum: 0 },
        action: { type: 'string', minLength: 1, maxLength: 1024 },
      },
    },
    {
      additionalProperties: false,
      required: ['type', 'status', 'exit_code'],
      properties: {
        type: { type: 'string', enum: ['result'] },
        status: { type: 'string', enum: ['SUCCESS', 'ERROR'] },
        exit_code: { type: 'integer' },
        telemetry: {
          type: 'object',
          additionalProperties: false,
          properties: {
            input_tokens: { type: 'integer', minimum: 0 },
            output_tokens: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    {
      additionalProperties: false,
      required: ['type', 'timestamp'],
      properties: {
        type: { type: 'string', enum: ['heartbeat'] },
        timestamp: { type: 'integer', minimum: 0 },
      },
    },
  ],
};

export const PROSECUTION_VERDICT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['ship', 'block'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'charge', 'claim'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          charge: { type: 'string' },
          claim: { type: 'string' },
          file: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
};

export const COLDSTART_VERDICT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['gaps'],
  properties: {
    gaps: { type: 'array', items: { type: 'string' } },
  },
};

export const PARALLAX_VERDICT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['ambiguities'],
  properties: {
    ambiguities: { type: 'array', items: { type: 'string' } },
  },
};

export const BRAIN_PLAN_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'gate', 'tickets'],
  properties: {
    repo: { type: 'string' },
    base: { type: 'string', pattern: '^[a-zA-Z0-9_.-]+$' },
    concurrencyCap: { type: ['integer', 'null'], minimum: 1 },
    disableOrchestrator: { type: 'boolean' },
    gate: {
      type: 'object',
      additionalProperties: false,
      anyOf: [
        { required: ['build'] },
        { required: ['test'] },
      ],
      properties: {
        build: { type: 'string', pattern: '^npm (test|run [a-zA-Z0-9_:-]+)$' },
        test: { type: 'string', pattern: '^npm (test|run [a-zA-Z0-9_:-]+)$' },
      },
    },
    tickets: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'body', 'scope', 'edges'],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
          title: { type: 'string', minLength: 1 },
          body: { type: 'string', minLength: 1 },
          scope: {
            type: 'array',
            items: {
              type: 'string',
              pattern:
                '^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\*{1,2}(?:\\.[a-zA-Z0-9_-]+)?|[a-zA-Z0-9_.-]*\\*[a-zA-Z0-9_.-]*)(?:/(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\*{1,2}(?:\\.[a-zA-Z0-9_-]+)?|[a-zA-Z0-9_.-]*\\*[a-zA-Z0-9_.-]*))*$',
            },
          },
          rails: {
            type: 'array',
            items: {
              type: 'string',
              pattern:
                '^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\*{1,2}(?:\\.[a-zA-Z0-9_-]+)?|[a-zA-Z0-9_.-]*\\*[a-zA-Z0-9_.-]*)(?:/(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\.[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\\*{1,2}(?:\\.[a-zA-Z0-9_-]+)?|[a-zA-Z0-9_.-]*\\*[a-zA-Z0-9_.-]*))*$',
            },
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['to'],
              properties: {
                to: { type: 'string' },
                contract: { type: 'string' },
              },
            },
          },
          tier: { type: 'string', enum: ['cheap', 'mid', 'frontier'] },
          pool_hint: { type: 'string', enum: ['gemini', 'claude', 'claude-gpt', 'gpt-oss', 'auto'] },
        },
      },
    },
  },
};

export const COLDSTART_FINDINGS_SCHEMA = COLDSTART_VERDICT_SCHEMA;
export const COLDSTART_SCHEMA = COLDSTART_VERDICT_SCHEMA;

export const REVIEW_FINDINGS_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['findings'],
  properties: {
    verdict: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'claim'],
        properties: {
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low', 'blocker', 'major', 'minor', 'nit'],
          },
          charge: { type: 'string' },
          file: { type: 'string' },
          line: { type: ['string', 'integer'] },
          claim: { type: 'string' },
          evidence: { type: ['string', 'null'] },
        },
      },
    },
  },
};

export const ARL_FINDING_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'claim'],
        properties: {
          id: { type: 'string' },
          lens: { type: 'string' },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low', 'blocker', 'major', 'minor', 'nit'],
          },
          confidence: { type: ['string', 'number'] },
          file: { type: 'string' },
          location: { type: 'string' },
          line: { type: 'string' },
          ticket_id: { type: 'string' },
          target_ref: { type: ['string', 'null'] },
          claim: { type: 'string' },
          evidence: { type: ['string', 'null'] },
          blast_radius: { type: 'boolean' },
          resolution_route: { type: 'string', enum: ['auto-fix', 'grill-me'] },
          suggested_fix: { type: 'string' },
        },
      },
    },
  },
};

export const ARBITER_TRIAGE_SCHEMA = {
  type: 'object',
  required: ['gate_verdict', 'summary', 'triaged'],
  properties: {
    gate_verdict: { type: 'string', enum: ['SHIP', 'ITERATE'] },
    summary: { type: 'string' },
    triaged: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'severity', 'claim', 'verdict'],
        properties: {
          id: { type: 'string' },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low', 'blocker', 'major', 'minor', 'nit'],
          },
          file: { type: 'string' },
          location: { type: 'string' },
          line: { type: 'string' },
          ticket_id: { type: 'string' },
          lens: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: ['string', 'null'] },
          blast_radius: { type: 'boolean' },
          verdict: { type: 'string', enum: ['accept-candidate', 'escalate', 'drop'] },
          resolution_route: { type: 'string', enum: ['auto-fix', 'grill-me'] },
          rationale: { type: 'string' },
        },
      },
    },
  },
};
