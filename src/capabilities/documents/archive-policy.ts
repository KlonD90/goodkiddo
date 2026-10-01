import yauzl from 'yauzl';

// Check both declared and actual expanded sizes before ExcelJS materializes XML.
export async function validateSpreadsheetArchive(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new Error('Повреждённый XLSX.'));
          return;
        }
        let count = 0;
        let declared = 0;
        let expanded = 0;
        let settled = false;
        const finish = (failure?: Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          zip.close();
          failure ? reject(failure) : resolve();
        };
        const abort = () => finish(new Error('Обработка файла остановлена.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        zip.on('error', () => finish(new Error('Повреждённый XLSX.')));
        zip.on('end', () => finish());
        zip.on('entry', (entry) => {
          count++;
          declared += entry.uncompressedSize;
          if (
            count > 1000 ||
            declared > 32 * 1024 * 1024 ||
            entry.generalPurposeBitFlag & 1
          ) {
            finish(
              new Error('XLSX превышает лимит распаковки или зашифрован.'),
            );
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              finish(new Error('Повреждённый XLSX.'));
              return;
            }
            stream.on('data', (chunk: Buffer) => {
              expanded += chunk.length;
              if (expanded > 32 * 1024 * 1024) {
                stream.destroy();
                finish(new Error('XLSX превышает лимит распаковки.'));
              }
            });
            stream.on('error', () => finish(new Error('Повреждённый XLSX.')));
            stream.on('end', () => {
              if (!settled) zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}
