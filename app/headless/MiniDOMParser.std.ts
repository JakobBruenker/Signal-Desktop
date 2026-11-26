// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// DOMParser for the headless backend, covering what link previews read
// (ts/linkPreviews/linkPreviewFetch.preload.ts): <meta>/<link> attributes
// found with selectors like `meta[property="og:title"]` or `meta[charset]`,
// and the document title. Not a general HTML parser.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity.startsWith('#')) {
        const code =
          entity[1] === 'x' || entity[1] === 'X'
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    }
  );
}

type MiniElement = Readonly<{
  tagName: string;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
}>;

function createElement(
  tagName: string,
  attributes: ReadonlyMap<string, string>
): MiniElement {
  return {
    tagName: tagName.toUpperCase(),
    getAttribute: name => attributes.get(name.toLowerCase()) ?? null,
    hasAttribute: name => attributes.has(name.toLowerCase()),
  };
}

const ATTRIBUTE_RE =
  /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE_RE)) {
    const [, name, doubleQuoted, singleQuoted, unquoted] = match;
    if (name && !attributes.has(name.toLowerCase())) {
      attributes.set(
        name.toLowerCase(),
        decodeEntities(doubleQuoted ?? singleQuoted ?? unquoted ?? '')
      );
    }
  }
  return attributes;
}

// `tag`, `tag[attr]` or `tag[attr="value"]`
const SELECTOR_RE = /^([a-z]+)(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/i;

type MiniDocument = Readonly<{
  title: string;
  querySelectorAll: (selector: string) => Array<MiniElement>;
  querySelector: (selector: string) => MiniElement | null;
}>;

function createDocument(
  title: string,
  elements: ReadonlyArray<MiniElement>
): MiniDocument {
  const querySelectorAll = (selector: string): Array<MiniElement> => {
    const match = SELECTOR_RE.exec(selector.trim());
    if (!match) {
      throw new Error(`MiniDOMParser: unsupported selector ${selector}`);
    }
    const [, tag = '', attribute, value] = match;
    return elements.filter(element => {
      if (element.tagName !== tag.toUpperCase()) {
        return false;
      }
      if (attribute == null) {
        return true;
      }
      if (value == null) {
        return element.hasAttribute(attribute);
      }
      return element.getAttribute(attribute) === value;
    });
  };
  return {
    title,
    querySelectorAll,
    querySelector: selector => querySelectorAll(selector)[0] ?? null,
  };
}

export class MiniDOMParser {
  parseFromString(html: string, _type: string): MiniDocument {
    // Comments and scripts could contain tag-like text
    const cleaned = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');

    const elements: Array<MiniElement> = [];
    for (const match of cleaned.matchAll(/<(meta|link)\b([^>]*)>/gi)) {
      const [, tag = '', attributes = ''] = match;
      elements.push(createElement(tag, parseAttributes(attributes)));
    }

    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(cleaned);
    const title = decodeEntities(titleMatch?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    return createDocument(title, elements);
  }
}
