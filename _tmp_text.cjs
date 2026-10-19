
const fs = require('fs');
(async () => {
  const pdfjs = await import('file:///E:/识谱弹琴/vendor/pdfjs/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(process.argv[1]));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items = [];
    for (const item of content.items) {
      if (item.str && item.str.trim()) {
        items.push({ str: item.str, x: Math.round(item.transform[4]), y: Math.round(item.transform[5]) });
      }
    }
    out.push({ page: n, items });
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
  console.log('pages', out.length);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
