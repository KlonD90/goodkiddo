import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { extractAttachment } from './extract.js';

const signal = new AbortController().signal;
describe('attachment extraction', () => {
  it('parses quoted and multiline CSV with semicolon delimiters', async () => {
    const result = await extractAttachment({
      filename: 'test.csv',
      mimeType: 'text/csv',
      bytes: new TextEncoder().encode('name;note\nAda;"first; second\nthird"'),
      signal,
    });
    expect(result.text).toContain('["Ada","first; second\\nthird"]');
    expect(result.untrusted).toBe(true);
  });
  it('reads all bounded XLSX sheets and preserves formulas without evaluating them', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('First').addRows([
      ['name', 'value'],
      ['Ada', 42],
    ]);
    workbook.addWorksheet('Second').getCell('A1').value = {
      formula: '1+1',
      result: 2,
    };
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    const result = await extractAttachment({
      filename: 'test.xlsx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes,
      signal,
    });
    expect(result.text).toContain('[Sheet First]');
    expect(result.text).toContain('["Ada","42"]');
    expect(result.text).toContain('=1+1');
  });
  it('rejects oversize, damaged and unsupported files', async () => {
    await expect(
      extractAttachment({
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        bytes: new Uint8Array(10 * 1024 * 1024 + 1),
        signal,
      }),
    ).rejects.toThrow('10 MiB');
    await expect(
      extractAttachment({
        filename: 'x.xlsx',
        mimeType: '',
        bytes: new Uint8Array([1, 2]),
        signal,
      }),
    ).rejects.toThrow('XLSX');
    await expect(
      extractAttachment({
        filename: 'x.pdf',
        mimeType: '',
        bytes: new Uint8Array([1, 2]),
        signal,
      }),
    ).rejects.toThrow('прочитать');
    await expect(
      extractAttachment({
        filename: 'x.xls',
        mimeType: 'application/vnd.ms-excel',
        bytes: new Uint8Array([1, 2]),
        signal,
      }),
    ).rejects.toThrow('XLS');
  });
  it('reads a synthetic text PDF and supports cancellation', async () => {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const content = 'BT /F1 12 Tf 10 200 Td (Synthetic hello) Tj ET';
    objects.push(
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const [i, object] of objects.entries()) {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => String(offset).padStart(10, '0') + ' 00000 n ')
      .join(
        '\n',
      )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const result = await extractAttachment({
      filename: 'synthetic.pdf',
      mimeType: 'application/pdf',
      bytes: new TextEncoder().encode(pdf),
      signal,
    });
    expect(result.text).toContain('Synthetic hello');
    expect(result.pages).toBe(1);
    const abort = new AbortController();
    abort.abort();
    await expect(
      extractAttachment({
        filename: 'x.csv',
        mimeType: 'text/csv',
        bytes: new Uint8Array(),
        signal: abort.signal,
      }),
    ).rejects.toThrow();
  });
});
