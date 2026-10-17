const https = require('https');
const { randomUUID } = require('node:crypto');

class SourceError extends Error {
  constructor(code, httpStatus) { super(code); this.code = code; this.httpStatus = httpStatus; }
}

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers, timeout: 10000 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('error', () => reject(new SourceError('UPSTREAM_TRANSPORT_FAILURE')));
      response.on('end', () => {
        const status = response.statusCode;
        if (status < 200 || status >= 300) return reject(new SourceError('UPSTREAM_HTTP_FAILURE', status));
        if (/^\s*</.test(body)) return reject(new SourceError('UPSTREAM_NON_JSON', status));
        try { resolve(JSON.parse(body.replace(/^jQuery\d*_?\(/, '').replace(/\);?$/, ''))); }
        catch { reject(new SourceError('UPSTREAM_JSON_INVALID', status)); }
      });
    }).on('error', () => reject(new SourceError('UPSTREAM_TRANSPORT_FAILURE')))
      .on('timeout', function () { this.destroy(); reject(new SourceError('UPSTREAM_TIMEOUT')); });
  });
}

function parseRows(payload, source) {
  // A recognized row container cannot override an explicit business failure.
  if (payload?.success === false) throw new SourceError('UPSTREAM_BUSINESS_FAILURE');
  // These success codes are verified against the public website responses.
  if ((source === 'eastmoney' && payload?.code !== undefined && ![1, '1'].includes(payload.code))
    || (source === 'cls' && payload?.errno !== undefined && payload.errno !== 0)) {
    throw new SourceError('UPSTREAM_BUSINESS_FAILURE');
  }
  const container = payload?.data;
  const rows = source === 'eastmoney' ? container?.fastNewsList : container?.roll_data;
  const selected = Array.isArray(rows) ? rows : Array.isArray(container) ? container : null;
  if (!selected) throw new SourceError('UPSTREAM_SHAPE_INVALID');
  if (selected.some(row => !row || typeof row !== 'object' || Array.isArray(row)
    || ![row.title, row.brief, row.content, row.summary].some(value => typeof value === 'string' && value.trim()))) {
    throw new SourceError('UPSTREAM_ROWS_INVALID');
  }
  return selected.map(item => ({ source, title: item.title || item.brief || item.content || item.summary || '',
    content: item.content || item.summary || item.digest || item.brief || '',
    time: item.time || item.ctime || item.showTime || item.show_time || item.pub_time || '',
    url: item.url || item.shareurl || item.share_url || '', tags: item.tags || item.subjects || [] }));
}

async function readSource(source) {
  const url = source === 'eastmoney'
    ? `https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=30&req_trace=${randomUUID()}`
    : 'https://www.cls.cn/api/cache?name=telegraph';
  try {
    const rows = parseRows(await fetchJson(url, { 'User-Agent': 'Mozilla/5.0', Referer: source === 'eastmoney'
      ? 'https://kuaixun.eastmoney.com/' : 'https://www.cls.cn/telegraph' }), source);
    return { rows, status: rows.length ? 'OK' : 'EMPTY', count: rows.length, confirmedEmpty: !rows.length };
  } catch (error) {
    return { rows: [], status: 'FAILED', count: null, confirmedEmpty: false,
      error: { code: error instanceof SourceError ? error.code : 'UPSTREAM_FAILURE',
        ...(error instanceof SourceError && error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}) } };
  }
}

async function newsCatalysts() {
  const sources = ['eastmoney', 'cls'];
  // Preserve the existing two calls, in parallel, without retry or fallback.
  const results = await Promise.all(sources.map(readSource));
  const usable = results.filter(result => result.status !== 'FAILED').length;
  const keys = ['AI', '算力', '机器人', '半导体', '芯片', '创新药', '医药', '固态电池', '低空经济', '光伏', '锂电', '涨价', '订单', '并购', '重组', '政策', '关税', '出口', '业绩', '预增'];
  const items = results.flatMap(result => result.rows).map(item => ({ ...item,
    catalystScore: keys.reduce((score, key) => score + (`${item.title} ${item.content}`.includes(key) ? 1 : 0), 0) }))
    .sort((a, b) => b.catalystScore - a.catalystScore);
  const status = !usable ? 'FAILED' : usable < sources.length ? 'PARTIAL' : items.length ? 'OK' : 'EMPTY';
  return { success: usable > 0, status, count: usable ? items.length : null, data: items.slice(0, 50),
    confirmedEmpty: status === 'EMPTY',
    sourceStatus: Object.fromEntries(sources.map((source, i) => [source,
      results[i].status === 'FAILED' ? { error: results[i].error.code } : 'ok'])),
    sourceDiagnostics: Object.fromEntries(sources.map((source, i) => {
      const { rows, ...diagnostic } = results[i]; return [source, diagnostic];
    })),
    note: ['FAILED', 'PARTIAL'].includes(status) ? '新闻来源不完整；零条不代表市场没有消息。' : '消息仅用于复盘催化线索。',
    updateTime: new Date().toISOString() };
}

module.exports = { newsCatalysts };
