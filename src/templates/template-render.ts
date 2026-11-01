import type {
  ReplyButton,
  TemplateMessage,
} from '../whatsapp/whatsapp.client.js';

/**
 * A value to fill in a template: `{{1}}` (positional) or `{{name}}` (named)
 * in the header, the body or a URL button's link.
 */
export interface TemplateVariable {
  /** Stable key, e.g. `body.1`, `header.name`, `button.0.1`. */
  key: string;
  component: 'header' | 'body' | 'button';
  /** The placeholder's name without braces: "1", "first_name". */
  name: string;
  /** Meta's sample value, when the template has one. */
  example: string | null;
}

export interface RenderedTemplate {
  /** Meta's `template` object for the send. */
  message: TemplateMessage;
  /** The text kept in the thread: header, body and footer with the values. */
  text: string;
  /** Quick reply buttons, shown in the thread like the bot's buttons. */
  buttons: ReplyButton[];
}

/** A value is missing, or the template cannot be filled. */
export class TemplateValuesError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = 'TemplateValuesError';
  }
}

type Json = Record<string, unknown>;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Header formats that need a file or a place: not sent from the inbox yet. */
const SUPPORTED_HEADER_FORMATS = new Set(['TEXT']);
/** Buttons that need no value or only a link suffix. */
const SUPPORTED_BUTTONS = new Set(['QUICK_REPLY', 'URL', 'PHONE_NUMBER']);

/**
 * Why a template cannot be sent from the inbox, or null when it can.
 * Authentication templates (codes) are sent by systems, not people; media
 * headers and special buttons (copy code, flows, catalog) need inputs the
 * inbox does not collect yet.
 */
export function unsupportedReason(
  category: string,
  components: unknown,
): string | null {
  if (category === 'AUTHENTICATION') {
    return 'authentication templates are not sent from the inbox';
  }
  for (const component of list(components)) {
    const type = upper(component['type']);
    if (type === 'HEADER') {
      const format = upper(component['format']) || 'TEXT';
      if (!SUPPORTED_HEADER_FORMATS.has(format)) {
        return `${format.toLowerCase()} headers are not supported yet`;
      }
    }
    if (type === 'BUTTONS') {
      for (const button of list(component['buttons'])) {
        const kind = upper(button['type']);
        if (!SUPPORTED_BUTTONS.has(kind)) {
          return `${kind.toLowerCase() || 'unknown'} buttons are not supported yet`;
        }
      }
    }
  }
  return null;
}

/**
 * The template's variables in send order: header, body, then each URL
 * button's link. Within a component each placeholder appears once, in
 * order of first appearance (positional ones by number).
 */
export function templateVariables(components: unknown): TemplateVariable[] {
  const variables: TemplateVariable[] = [];
  for (const component of list(components)) {
    const type = upper(component['type']);
    if (type === 'HEADER') {
      const names = placeholders(component['text']);
      const examples = headerExamples(component);
      names.forEach((name, i) =>
        variables.push({
          key: `header.${name}`,
          component: 'header',
          name,
          example: examples.get(name) ?? examples.get(String(i + 1)) ?? null,
        }),
      );
    }
    if (type === 'BODY') {
      const names = placeholders(component['text']);
      const examples = bodyExamples(component);
      names.forEach((name, i) =>
        variables.push({
          key: `body.${name}`,
          component: 'body',
          name,
          example: examples.get(name) ?? examples.get(String(i + 1)) ?? null,
        }),
      );
    }
    if (type === 'BUTTONS') {
      list(component['buttons']).forEach((button, index) => {
        if (upper(button['type']) !== 'URL') {
          return;
        }
        // A URL button's sample is the full link, not the value alone.
        const example = firstString(button['example']);
        for (const name of placeholders(button['url'])) {
          variables.push({
            key: `button.${index}.${name}`,
            component: 'button',
            name,
            example,
          });
        }
      });
    }
  }
  return variables;
}

/**
 * Fills the template with `values` (one per variable, in
 * {@link templateVariables} order). Throws {@link TemplateValuesError} when
 * the count does not match, a value is empty, or a value has what WhatsApp
 * rejects in a parameter (line breaks, tabs, more than 4 spaces in a row).
 */
export function renderTemplate(
  template: { name: string; language: string; components: unknown },
  values: readonly string[],
): RenderedTemplate {
  const variables = templateVariables(template.components);
  if (values.length > variables.length) {
    throw new TemplateValuesError(
      `The template has ${variables.length} variables and ${values.length} values were given`,
    );
  }
  const filled = new Map<string, string>();
  const missing: string[] = [];
  variables.forEach((variable, i) => {
    const value = (values[i] ?? '').trim();
    if (!value) {
      missing.push(variable.key);
      return;
    }
    if (/[\n\t]| {5,}/.test(value)) {
      throw new TemplateValuesError(
        `Value for ${variable.key} has a line break, a tab or more than 4 spaces in a row`,
      );
    }
    filled.set(variable.key, value);
  });
  if (missing.length > 0) {
    throw new TemplateValuesError(
      `Missing values: ${missing.join(', ')}`,
      missing,
    );
  }

  const sendComponents: Record<string, unknown>[] = [];
  const textParts: string[] = [];
  const buttons: ReplyButton[] = [];
  for (const component of list(template.components)) {
    const type = upper(component['type']);
    if (type === 'HEADER' || type === 'BODY') {
      const prefix = type === 'HEADER' ? 'header' : 'body';
      const text =
        typeof component['text'] === 'string' ? component['text'] : '';
      const names = placeholders(text);
      if (names.length > 0) {
        sendComponents.push({
          type: prefix,
          parameters: names.map((name) => ({
            type: 'text',
            text: filled.get(`${prefix}.${name}`),
            ...(isNamed(name) ? { parameter_name: name } : {}),
          })),
        });
      }
      if (text) {
        textParts.push(fill(text, (name) => filled.get(`${prefix}.${name}`)));
      }
    }
    if (type === 'FOOTER' && typeof component['text'] === 'string') {
      textParts.push(component['text']);
    }
    if (type === 'BUTTONS') {
      list(component['buttons']).forEach((button, index) => {
        const kind = upper(button['type']);
        if (kind === 'QUICK_REPLY' && typeof button['text'] === 'string') {
          buttons.push({ id: `template_${index}`, title: button['text'] });
        }
        if (kind === 'URL') {
          const names = placeholders(button['url']);
          if (names.length > 0) {
            sendComponents.push({
              type: 'button',
              sub_type: 'url',
              index: String(index),
              parameters: names.map((name) => ({
                type: 'text',
                text: filled.get(`button.${index}.${name}`),
              })),
            });
          }
        }
      });
    }
  }

  return {
    message: {
      name: template.name,
      language: template.language,
      components: sendComponents,
    },
    text: textParts.join('\n\n'),
    buttons,
  };
}

function list(value: unknown): Json[] {
  return Array.isArray(value)
    ? value.filter((v): v is Json => !!v && typeof v === 'object')
    : [];
}

function upper(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase() : '';
}

function isNamed(name: string): boolean {
  return !/^\d+$/.test(name);
}

/** Distinct placeholder names; positional ones sorted by number. */
function placeholders(text: unknown): string[] {
  if (typeof text !== 'string') {
    return [];
  }
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names.every((n) => !isNamed(n))
    ? names.sort((a, b) => Number(a) - Number(b))
    : names;
}

function fill(text: string, value: (name: string) => string | undefined) {
  return text.replace(
    PLACEHOLDER,
    (whole, name: string) => value(name) ?? whole,
  );
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** Meta's samples: `header_text` (positional) or `header_text_named_params`. */
function headerExamples(component: Json): Map<string, string> {
  const example = (component['example'] ?? {}) as Json;
  const examples = new Map<string, string>();
  const positional = example['header_text'];
  if (Array.isArray(positional)) {
    positional.forEach((value, i) => {
      if (typeof value === 'string') {
        examples.set(String(i + 1), value);
      }
    });
  }
  for (const item of list(example['header_text_named_params'])) {
    if (
      typeof item['param_name'] === 'string' &&
      typeof item['example'] === 'string'
    ) {
      examples.set(item['param_name'], item['example']);
    }
  }
  return examples;
}

/** Meta's samples: `body_text` ([[...]]) or `body_text_named_params`. */
function bodyExamples(component: Json): Map<string, string> {
  const example = (component['example'] ?? {}) as Json;
  const examples = new Map<string, string>();
  const rows = example['body_text'];
  const first: unknown = Array.isArray(rows) ? rows[0] : undefined;
  if (Array.isArray(first)) {
    first.forEach((value, i) => {
      if (typeof value === 'string') {
        examples.set(String(i + 1), value);
      }
    });
  }
  for (const item of list(example['body_text_named_params'])) {
    if (
      typeof item['param_name'] === 'string' &&
      typeof item['example'] === 'string'
    ) {
      examples.set(item['param_name'], item['example']);
    }
  }
  return examples;
}
