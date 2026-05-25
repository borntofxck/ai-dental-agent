import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(process.cwd());
const baseDir = path.resolve(repoRoot, '..');
const templatePath = path.join(baseDir, 'Шаблон для следующих дипломов', 'ПЗ Жихарева финальная - шаблон.docx');
const assetsDir = path.join(baseDir, 'docs', 'diploma_assets');
const contentPath = path.join(assetsDir, 'diploma_content.json');
const outputPath = path.join(baseDir, 'docs', 'ПЗ AI Dental Agent.docx');
const tempDir = path.join(os.tmpdir(), `ai-dental-diploma-${Date.now()}`);

const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU_PER_CM = 360000;

function psq(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(command) {
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    stdio: 'inherit',
  });
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function runText(text, opts = {}) {
  const font = opts.font ?? 'Times New Roman';
  const size = opts.size ?? 28;
  const bold = opts.bold ? '<w:b/><w:bCs/>' : '';
  const italic = opts.italic ? '<w:i/><w:iCs/>' : '';
  const color = opts.color ? `<w:color w:val="${opts.color}"/>` : '';
  const lines = String(text ?? '').split(/\r?\n/);
  const body = lines.map((line, index) => {
    const space = /^\s|\s$/.test(line) ? ' xml:space="preserve"' : '';
    return `${index ? '<w:br/>' : ''}<w:t${space}>${xmlEscape(line)}</w:t>`;
  }).join('');

  return `<w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>${bold}${italic}${color}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>${body || '<w:t></w:t>'}</w:r>`;
}

function paragraph(text = '', opts = {}) {
  const pStyle = opts.style ? `<w:pStyle w:val="${opts.style}"/>` : '';
  const outline = opts.outlineLevel != null ? `<w:outlineLvl w:val="${opts.outlineLevel}"/>` : '';
  const jc = opts.align ? `<w:jc w:val="${opts.align}"/>` : '';
  const firstLine = opts.firstLine === false ? '' : `<w:ind w:firstLine="${opts.firstLine ?? 708}"/>`;
  const spacing = `<w:spacing w:before="${opts.before ?? 0}" w:after="${opts.after ?? 120}" w:line="${opts.line ?? 360}" w:lineRule="auto"/>`;
  const keepNext = opts.keepNext ? '<w:keepNext/>' : '';
  const pPr = `<w:pPr>${pStyle}${keepNext}${outline}${spacing}${firstLine}${jc}</w:pPr>`;
  return `<w:p>${pPr}${opts.rawBefore ?? ''}${runText(text, opts)}${opts.rawAfter ?? ''}</w:p>`;
}

function pageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function heading(block) {
  const level = Math.min(Math.max(Number(block.level || 1), 1), 3);
  const size = level === 1 ? 30 : 28;
  const before = level === 1 ? 240 : 180;
  const align = level === 1 ? 'center' : 'left';
  return paragraph(block.text, {
    style: String(level),
    outlineLevel: level - 1,
    bold: true,
    size,
    align,
    firstLine: false,
    before,
    after: 160,
    keepNext: true,
  });
}

function tocBlock() {
  return [
    paragraph('СОДЕРЖАНИЕ', {
      bold: true,
      align: 'center',
      firstLine: false,
      before: 0,
      after: 240,
      size: 28,
    }),
    `<w:p><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr>` +
      `<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>` +
      `<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
      runText('Оглавление обновится при открытии документа в Word.', { size: 28 }) +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
      `</w:p>`,
    pageBreak(),
  ].join('');
}

function tableBlock(block) {
  const rows = [block.headers, ...block.rows];
  const columnCount = block.headers.length;
  const totalWidth = 9360;
  const colWidth = Math.floor(totalWidth / Math.max(1, columnCount));
  const grid = Array.from({ length: columnCount }, () => `<w:gridCol w:w="${colWidth}"/>`).join('');
  const tableRows = rows.map((row, rowIndex) => {
    const cells = row.map((cell) => {
      const fill = rowIndex === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="EDEDED"/>' : '';
      const text = String(cell ?? '');
      return `<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/>${fill}<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr>${paragraph(text, {
        bold: rowIndex === 0,
        size: 22,
        firstLine: false,
        align: rowIndex === 0 ? 'center' : 'left',
        before: 0,
        after: 0,
        line: 300,
      })}</w:tc>`;
    }).join('');
    return `<w:tr>${cells}</w:tr>`;
  }).join('');

  return [
    paragraph(`Таблица ${block.number} - ${block.caption}`, {
      bold: true,
      firstLine: false,
      before: 120,
      after: 80,
      size: 28,
      keepNext: true,
    }),
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="777777"/><w:left w:val="single" w:sz="4" w:space="0" w:color="777777"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="777777"/><w:right w:val="single" w:sz="4" w:space="0" w:color="777777"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="AAAAAA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="AAAAAA"/></w:tblBorders><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${tableRows}</w:tbl>`,
    paragraph(block.note ?? '', {
      firstLine: 708,
      before: 100,
      after: 160,
      size: 28,
    }),
  ].join('');
}

function codeBlock(block) {
  return [
    paragraph(block.caption, {
      bold: true,
      firstLine: false,
      before: 120,
      after: 80,
      size: 28,
      keepNext: true,
    }),
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/></w:tblBorders></w:tblPr><w:tr><w:tc><w:tcPr><w:tcW w:w="9360" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:tcMar><w:top w:w="100" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr>${paragraph(block.text, {
      font: 'Consolas',
      size: 20,
      firstLine: false,
      before: 0,
      after: 0,
      line: 260,
    })}</w:tc></w:tr></w:tbl>`,
    paragraph('', { firstLine: false, after: 120 }),
  ].join('');
}

function readPngSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    return { width: 1200, height: 800 };
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function imageBlock(block, relId, pictureId) {
  const size = readPngSize(block.path);
  const maxWidthCm = 15.5;
  const maxHeightCm = 16.2;
  const widthCmRaw = size.width / 96 * 2.54;
  const heightCmRaw = size.height / 96 * 2.54;
  const scale = Math.min(maxWidthCm / widthCmRaw, maxHeightCm / heightCmRaw, 1);
  const cx = Math.round(widthCmRaw * scale * EMU_PER_CM);
  const cy = Math.round(heightCmRaw * scale * EMU_PER_CM);
  const name = xmlEscape(path.basename(block.path));

  return [
    `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="80"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${pictureId}" name="${name}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${pictureId}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
    paragraph(`Рисунок ${block.number} - ${block.caption}`, {
      align: 'center',
      firstLine: false,
      before: 0,
      after: 160,
      size: 26,
    }),
  ].join('');
}

function renderContent(blocks, figureRels) {
  let figureIndex = 0;
  return tocBlock() + blocks.map((block) => {
    if (block.type === 'heading') return heading(block);
    if (block.type === 'paragraph') return paragraph(block.text);
    if (block.type === 'pageBreak') return pageBreak();
    if (block.type === 'table') return tableBlock(block);
    if (block.type === 'code') return codeBlock(block);
    if (block.type === 'figure') {
      const rel = figureRels[figureIndex++];
      return imageBlock(block, rel.id, 1000 + figureIndex);
    }
    return '';
  }).join('');
}

function replaceDocumentXml(documentXml, generatedXml) {
  const bodyStartMatch = documentXml.match(/<w:body>/);
  if (!bodyStartMatch) throw new Error('Cannot find w:body start');
  const bodyStart = bodyStartMatch.index + bodyStartMatch[0].length;
  const bodyEnd = documentXml.lastIndexOf('</w:body>');
  if (bodyEnd < 0) throw new Error('Cannot find w:body end');

  const beforeBody = documentXml.slice(0, bodyStart);
  const body = documentXml.slice(bodyStart, bodyEnd);
  const afterBody = documentXml.slice(bodyEnd);

  const contentMarker = body.indexOf('СОДЕРЖАНИЕ');
  if (contentMarker < 0) throw new Error('Cannot find СОДЕРЖАНИЕ marker in template');

  const paraStarts = [...body.matchAll(/<w:p(?=[\s>])/g)].map((match) => match.index);
  const replaceStart = paraStarts.filter((index) => index <= contentMarker).pop();
  if (replaceStart == null) throw new Error('Cannot find paragraph before content marker');

  const sectStart = body.lastIndexOf('<w:sectPr');
  const sectEnd = body.lastIndexOf('</w:sectPr>');
  if (sectStart < 0 || sectEnd < 0) throw new Error('Cannot find final sectPr');
  const finalSectPr = body.slice(sectStart, sectEnd + '</w:sectPr>'.length);
  const preservedPrefix = body.slice(0, replaceStart);

  return `${beforeBody}${preservedPrefix}${generatedXml}${finalSectPr}${afterBody}`;
}

function updateRelationships(relsXml, figureRels) {
  const relXml = figureRels.map((rel) => (
    `<Relationship Id="${rel.id}" Type="${NS_REL}/image" Target="media/${rel.fileName}"/>`
  )).join('');
  return relsXml.replace('</Relationships>', `${relXml}</Relationships>`);
}

function updateContentTypes(contentTypesXml) {
  if (contentTypesXml.includes('Extension="png"')) return contentTypesXml;
  return contentTypesXml.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
}

function updateSettings(settingsXml) {
  if (settingsXml.includes('<w:updateFields')) return settingsXml;
  return settingsXml.replace('</w:settings>', '<w:updateFields w:val="true"/></w:settings>');
}

function updateStyles(stylesXml) {
  return stylesXml.replace(
    /<w:style\b(?=[^>]*w:styleId="(?:1|2|3)")[\s\S]*?<\/w:style>/g,
    (styleXml) => styleXml.replace(/<w:numPr>[\s\S]*?<\/w:numPr>/g, ''),
  );
}

function ensureDrawingNamespaces(documentXml) {
  let result = documentXml;
  const rootTag = result.match(/<w:document\b[^>]*>/)?.[0] ?? '';
  const additions = [];
  if (!rootTag.includes('xmlns:a=')) {
    additions.push('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"');
  }
  if (!rootTag.includes('xmlns:pic=')) {
    additions.push('xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"');
  }
  if (!additions.length) return result;
  return result.replace('<w:document ', `<w:document ${additions.join(' ')} `);
}

function validateXml(filePath) {
  runPowerShell(`try { [xml](Get-Content -LiteralPath ${psq(filePath)} -Raw -Encoding UTF8) | Out-Null; Write-Host OK } catch { Write-Error $_; exit 1 }`);
}

function main() {
  if (!fs.existsSync(templatePath)) throw new Error(`Template not found: ${templatePath}`);
  if (!fs.existsSync(contentPath)) throw new Error(`Content not found: ${contentPath}`);

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  runPowerShell(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${psq(templatePath)}, ${psq(tempDir)})`);

  const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
  const figures = content.blocks.filter((block) => block.type === 'figure');
  const figureRels = figures.map((figure, index) => {
    const fileName = `diploma_${index + 1}.png`;
    const target = path.join(tempDir, 'word', 'media', fileName);
    fs.copyFileSync(figure.path, target);
    return { id: `rIdDiploma${index + 1}`, fileName };
  });

  const documentXmlPath = path.join(tempDir, 'word', 'document.xml');
  const relsXmlPath = path.join(tempDir, 'word', '_rels', 'document.xml.rels');
  const contentTypesPath = path.join(tempDir, '[Content_Types].xml');
  const settingsPath = path.join(tempDir, 'word', 'settings.xml');
  const stylesPath = path.join(tempDir, 'word', 'styles.xml');

  const generatedXml = renderContent(content.blocks, figureRels);
  const documentXml = fs.readFileSync(documentXmlPath, 'utf8');
  fs.writeFileSync(documentXmlPath, ensureDrawingNamespaces(replaceDocumentXml(documentXml, generatedXml)), 'utf8');
  fs.writeFileSync(relsXmlPath, updateRelationships(fs.readFileSync(relsXmlPath, 'utf8'), figureRels), 'utf8');
  fs.writeFileSync(contentTypesPath, updateContentTypes(fs.readFileSync(contentTypesPath, 'utf8')), 'utf8');
  fs.writeFileSync(settingsPath, updateSettings(fs.readFileSync(settingsPath, 'utf8')), 'utf8');
  fs.writeFileSync(stylesPath, updateStyles(fs.readFileSync(stylesPath, 'utf8')), 'utf8');

  validateXml(documentXmlPath);
  validateXml(relsXmlPath);
  validateXml(contentTypesPath);
  validateXml(settingsPath);
  validateXml(stylesPath);

  fs.rmSync(outputPath, { force: true });
  runPowerShell(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${psq(tempDir)}, ${psq(outputPath)})`);

  console.log(JSON.stringify({
    ok: true,
    outputPath,
    figures: figures.length,
    blocks: content.blocks.length,
  }, null, 2));
}

main();
