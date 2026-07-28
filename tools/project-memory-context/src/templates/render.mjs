export function renderTemplate(content, placeholders) {
  return Object.entries(placeholders).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    content,
  );
}

export function hasBlockMarker(content, marker) {
  return content.includes(`<!-- pmc:${marker} -->`);
}

export function replaceOrAppendBlock(content, marker, block) {
  const open = `<!-- pmc:${marker} -->`;
  const close = `<!-- /pmc:${marker} -->`;
  const regex = new RegExp(`${open}[\\s\\S]*?${close}`, 'g');

  if (regex.test(content)) {
    return content.replace(regex, `${open}\n${block}\n${close}`);
  }

  if (content.trim().length === 0) {
    return `${open}\n${block}\n${close}\n`;
  }

  const prefix = content.endsWith('\n\n')
    ? content
    : content.endsWith('\n')
      ? `${content}\n`
      : `${content}\n\n`;

  return `${prefix}${open}\n${block}\n${close}\n`;
}

export function stripBlockMarkers(content, marker) {
  return content
    .replace(new RegExp(`<!-- pmc:${marker} -->|<!-- /pmc:${marker} -->`, 'g'), '')
    .trim();
}

export function wrapBlock(marker, block) {
  return `<!-- pmc:${marker} -->\n${block}\n<!-- /pmc:${marker} -->\n`;
}
