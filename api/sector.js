const { fetchFlow } = require('./sector-money-flow');
const { failure } = require('./_data-contracts');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json(failure('METHOD_NOT_ALLOWED', 'Method not allowed'));

  try {
    const result = await fetchFlow('both', 10, 'changePct');
    if (!result.success) {
      return res.status(503).json({
        ...result.validation,
        mode: 'hot_sectors_v4',
        data: result.data,
        diagnostics: {
          attempts: result.attempts,
          sources: result.sources,
          availableKinds: result.availableKinds,
          missingKinds: result.missingKinds,
        },
      });
    }
    const sectors = [...result.data]
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 10);
    return res.status(200).json({
      success: true,
      status: result.status,
      mode: 'hot_sectors_v4',
      source: result.source,
      count: sectors.length,
      data: sectors,
      diagnostics: {
        attempts: result.attempts,
        sources: result.sources,
        availableKinds: result.availableKinds,
        missingKinds: result.missingKinds,
      },
      updateTime: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({
      ...failure('UPSTREAM_FAILED', String(err?.message || err)),
      mode: 'hot_sectors_v4',
      data: [],
    });
  }
};
