// Only this trusted code executes in the worker. Documents are input bytes, never code.
export const DOCUMENT_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const MAX_CHARS = 20000;
function render(rows) {
  return rows.map(row => JSON.stringify(row.map(cell => String(cell ?? '').slice(0,2000)))).join('\n');
}
async function extract() {
  const {format,bytes,modules} = workerData;
  if(format === 'pdf') {
    const {PDFParse} = require(modules.pdf);
    const parser = new PDFParse({data:new Uint8Array(bytes),isEvalSupported:false,disableFontFace:true,useSystemFonts:false});
    try {
      const result = await parser.getText({first:50});
      const text = result.pages.map(p => '[Page '+p.num+']\n'+p.text).join('\n\n');
      return {text:text.slice(0,MAX_CHARS),truncated:result.total>50||text.length>MAX_CHARS,pages:result.total};
    } finally { await parser.destroy(); }
  }
  if(format === 'csv') {
    const {parse} = require(modules.csv);
    const source = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    const candidates = [',',';','\t'].map(delimiter => {
      try { return {delimiter,rows:parse(source,{delimiter,bom:true,trim:true,skip_empty_lines:true,relax_column_count:true,max_record_size:65536,to:201})}; }
      catch { return {delimiter,rows:[]}; }
    });
    const best = candidates.sort((a,b)=>(b.rows[0]?.length||0)-(a.rows[0]?.length||0))[0];
    if(source.trim() && !best.rows.length) throw new Error('invalid csv');
    const limited = best.rows.slice(0,200).map(row=>row.slice(0,20));
    const text = render(limited);
    return {text:text.slice(0,MAX_CHARS),truncated:best.rows.length>200||best.rows.some(row=>row.length>20)||text.length>MAX_CHARS};
  }
  const ExcelJS = require(modules.excel);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  let text='';
  let truncated=workbook.worksheets.length>10;
  for(const sheet of workbook.worksheets.slice(0,10)) {
    const rows=[];
    truncated ||= sheet.rowCount>200 || sheet.columnCount>20;
    for(let r=1;r<=Math.min(sheet.rowCount,200);r++) {
      const row=[];
      for(let c=1;c<=Math.min(sheet.columnCount,20);c++) {
        const cell=sheet.getRow(r).getCell(c);
        const value=cell.value;
        row.push(value && typeof value==='object' && ('formula' in value || 'sharedFormula' in value) ? '='+cell.formula : cell.text);
      }
      rows.push(row);
    }
    text+='[Sheet '+sheet.name+']\n'+render(rows)+'\n\n';
    if(text.length>MAX_CHARS) {truncated=true;break;}
  }
  return {text:text.slice(0,MAX_CHARS),truncated};
}
extract().then(result=>parentPort.postMessage({ok:true,...result}),()=>parentPort.postMessage({ok:false}));
`;
