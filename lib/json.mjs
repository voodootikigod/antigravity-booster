// Robust JSON extraction from LLM responses.
//
// LLM completions frequently produce JSON with RFC 8259 syntax defects:
// 1. Markdown code fences (```json ... ```)
// 2. Unescaped literal control characters in string literals (raw \n, \r, \t, \b, \f, U+0000..U+001F)
// 3. Invalid escape sequences (e.g. \s, \d, \w, \p from regex or single-escaped backslashes, invalid \u)
// 4. Trailing commas before closing braces/brackets in objects and arrays
// 5. Explanatory text (including bracketed citations like [1]) surrounding the JSON payload

function tryParseBalancedAt(source, start) {
  const stack = [];
  let inString = false;
  let isEscaped = false;
  let sanitized = '';
  let pendingComma = false;
  let pendingWhitespace = '';

  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        if (ch === '"' || ch === '\\' || ch === '/' || ch === 'b' || ch === 'f' || ch === 'n' || ch === 'r' || ch === 't') {
          sanitized += ch;
        } else if (ch === 'u') {
          const hex = source.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            sanitized += 'u';
          } else {
            sanitized += '\\u';
          }
        } else {
          sanitized += '\\' + ch;
        }
        continue;
      }

      if (ch === '\\') {
        isEscaped = true;
        sanitized += '\\';
      } else if (ch === '"') {
        inString = false;
        sanitized += '"';
      } else if (ch === '\n') {
        sanitized += '\\n';
      } else if (ch === '\r') {
        sanitized += '\\r';
      } else if (ch === '\t') {
        sanitized += '\\t';
      } else if (ch === '\b') {
        sanitized += '\\b';
      } else if (ch === '\f') {
        sanitized += '\\f';
      } else if (ch.charCodeAt(0) < 0x20) {
        sanitized += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
      } else {
        sanitized += ch;
      }
      continue;
    }

    if (pendingComma) {
      if (/\s/.test(ch)) {
        pendingWhitespace += ch;
        continue;
      }
      if (ch === '}' || ch === ']') {
        sanitized += pendingWhitespace;
        pendingComma = false;
        pendingWhitespace = '';
      } else {
        sanitized += ',' + pendingWhitespace;
        pendingComma = false;
        pendingWhitespace = '';
      }
    }

    if (ch === '"') {
      inString = true;
      sanitized += '"';
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
      sanitized += ch;
    } else if (ch === '}') {
      if (stack.length === 0 || stack[stack.length - 1] !== '{') {
        return { ok: false, error: 'unbalanced JSON in model output' };
      }
      stack.pop();
      sanitized += ch;
      if (stack.length === 0) break;
    } else if (ch === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== '[') {
        return { ok: false, error: 'unbalanced JSON in model output' };
      }
      stack.pop();
      sanitized += ch;
      if (stack.length === 0) break;
    } else if (ch === ',') {
      pendingComma = true;
      pendingWhitespace = '';
    } else {
      sanitized += ch;
    }
  }

  if (pendingComma) {
    sanitized += ',' + pendingWhitespace;
  }
  if (stack.length !== 0 || inString) {
    return { ok: false, error: 'unbalanced JSON in model output' };
  }

  try {
    return { ok: true, value: JSON.parse(sanitized), endOffset: start + sanitized.length };
  } catch (err) {
    return { ok: false, error: `failed to parse sanitized output: ${err.message}` };
  }
}

function extractFromCandidateString(source) {
  let sawDelimiter = false;
  let lastError = 'no JSON object or array found in model output';
  let fallbackScalarArray = null;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch !== '{' && ch !== '[') continue;
    sawDelimiter = true;
    const attempt = tryParseBalancedAt(source, i);
    if (!attempt.ok) {
      lastError = attempt.error;
      continue;
    }
    if (
      Array.isArray(attempt.value) &&
      attempt.value.length > 0 &&
      attempt.value.every((item) => typeof item === 'number') &&
      source.indexOf('{', i + 1) !== -1
    ) {
      if (!fallbackScalarArray) fallbackScalarArray = attempt;
      continue;
    }
    return attempt;
  }

  if (fallbackScalarArray) return fallbackScalarArray;
  return { ok: false, sawDelimiter, error: lastError };
}

/**
 * Robust JSON extraction from LLM responses.
 *
 * @param {string} text - Raw model response text containing JSON object or array.
 * @returns {any} Parsed JSON data.
 * @throws {Error} If input is invalid, no JSON is found, or JSON is unparseable.
 */
export function safeExtractJson(text) {
  if (typeof text !== 'string') {
    throw new Error('safeExtractJson: input is not a string');
  }

  // 1. Prefer an explicit outer fenced block without stripping fences inside JSON strings
  const fenceRe = /(?:^|\r?\n)[ \t]*(`{3,}|~{3,})(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1(?=[ \t]*(?:\r?\n|$))/gi;
  let match;
  while ((match = fenceRe.exec(text)) !== null) {
    const fencedRes = extractFromCandidateString(match[2]);
    if (fencedRes.ok) return fencedRes.value;
  }

  // 2. Fallback: scan raw text across candidate '{' / '[' offsets
  const directRes = extractFromCandidateString(text);
  if (directRes.ok) return directRes.value;

  // 3. Last resort for malformed/unclosed outer fence markers
  const stripped = text.replace(/^[ \t]*(?:`{3,}|~{3,})(?:json)?[ \t]*$/gim, '');
  if (stripped !== text) {
    const strippedRes = extractFromCandidateString(stripped);
    if (strippedRes.ok) return strippedRes.value;
  }

  throw new Error(`safeExtractJson: ${directRes.error}`);
}
