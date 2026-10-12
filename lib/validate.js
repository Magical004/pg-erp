// Tiny schema validator. Spec: { field: { type, required, max, min, values, label } }
// types: string | email | phone | int | date | month | enum | optionalInt
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// partial=true (updates): only validate fields that are present.
function validate(input, spec, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Invalid request body");
  const out = {};
  for (const [field, rule] of Object.entries(spec)) {
    const label = rule.label || field;
    let v = input[field];
    const missing = v === undefined || v === null || v === "";
    if (missing) {
      if (partial && v === undefined) continue;
      if (rule.required) throw new ValidationError(`${label} is required`);
      if (rule.type === "optionalInt" || rule.nullable) out[field] = null;
      else if (!partial && rule.default !== undefined) out[field] = rule.default;
      else if (rule.type === "string" || rule.type === "email" || rule.type === "phone") out[field] = "";
      continue;
    }
    switch (rule.type) {
      case "string":
        if (typeof v !== "string") throw new ValidationError(`${label} must be text`);
        v = v.trim();
        if (rule.required && !v) throw new ValidationError(`${label} is required`);
        if (v.length > (rule.max || 200)) throw new ValidationError(`${label} is too long`);
        break;
      case "email":
        v = String(v).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 120) throw new ValidationError(`${label} is not a valid email`);
        break;
      case "phone":
        v = String(v).replace(/[\s-]/g, "");
        if (!/^\+?\d{7,15}$/.test(v)) throw new ValidationError(`${label} is not a valid phone number`);
        break;
      case "int":
      case "optionalInt": {
        const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
        if (!Number.isInteger(n)) throw new ValidationError(`${label} must be a whole number`);
        if (rule.min !== undefined && n < rule.min) throw new ValidationError(`${label} must be at least ${rule.min}`);
        if (rule.max !== undefined && n > rule.max) throw new ValidationError(`${label} must be at most ${rule.max}`);
        v = n;
        break;
      }
      case "date":
        if (typeof v !== "string" || !validDate(v)) throw new ValidationError(`${label} must be a date (YYYY-MM-DD)`);
        break;
      case "month":
        if (typeof v !== "string" || !MONTH_RE.test(v)) throw new ValidationError(`${label} must be a month (YYYY-MM)`);
        break;
      case "enum":
        if (!rule.values.includes(v)) throw new ValidationError(`${label} must be one of: ${rule.values.join(", ")}`);
        break;
      default:
        throw new Error(`Unknown rule type ${rule.type}`);
    }
    out[field] = v;
  }
  return out;
}

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);

module.exports = { validate, ValidationError, validDate, today, thisMonth };
