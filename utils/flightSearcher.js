const fetch = require('node-fetch');

const DEST_AIRPORTS = {
  '欧洲':  ['LHR', 'CDG', 'FRA', 'AMS'],
  '日本':  ['NRT', 'HND'],
  '台湾':  ['TPE'],
  '韩国':  ['ICN'],
  '香港':  ['HKG'],
  '上海':  ['PVG'],
  '南京':  ['NKG'],
};

async function querySeatsAero(origin, dest, startDate, endDate, cabin, apiKey) {
  const params = new URLSearchParams({
    origin_airport:      origin,
    destination_airport: dest,
    cabin:               cabin || 'business',
    start_date:          startDate,
    end_date:            endDate,
    take:                '15',
  });
  const url = `https://seats.aero/partnerapi/availability?${params}`;
  try {
    const res = await fetch(url, {
      headers: { 'Partner-Authorization': apiKey, Accept: 'application/json' },
      timeout: 12000,
    });
    if (!res.ok) {
      console.warn(`[Flight] seats.aero ${dest} HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[Flight] seats.aero ${dest}: ${err.message}`);
    return null;
  }
}

async function searchFlights(config) {
  const {
    origin        = 'SFO',
    destinations  = Object.keys(DEST_AIRPORTS),
    cabin         = 'business',
    months        = 1,
    seatsAeroKey,
  } = config;

  if (!seatsAeroKey) {
    return { origin, cabin, note: 'seats.aero API Key 未配置', results: [], searchedAt: new Date().toISOString() };
  }

  const now       = new Date();
  const startDate = now.toISOString().split('T')[0];
  const endDate   = new Date(now.getTime() + months * 30 * 86400000).toISOString().split('T')[0];
  const results   = [];

  for (const destName of destinations) {
    const airports = DEST_AIRPORTS[destName] || [destName];
    for (const apt of airports.slice(0, 2)) {
      const data = await querySeatsAero(origin, apt, startDate, endDate, cabin, seatsAeroKey);
      if (data && Array.isArray(data.data) && data.data.length > 0) {
        results.push({
          destination: destName,
          airport:     apt,
          count:       data.data.length,
          dates:       data.data.slice(0, 6).map(d => ({
            date:  d.Date || d.date || '',
            j:     d.JAvailable || d.J || false,
            f:     d.FAvailable || d.F || false,
            seats: d.JSeats || d.Seats || '',
          })),
        });
        break; // found a result for this destination, move on
      }
    }
  }

  return { origin, cabin, startDate, endDate, results, searchedAt: new Date().toISOString() };
}

function formatFlightText(data, sessionLabel) {
  if (!data) return `${sessionLabel}：航班查询失败`;
  if (data.note) return `**${sessionLabel}积分商务舱查询**\n\n⚠️ ${data.note}`;

  let text = `## ${sessionLabel}积分商务舱机票\n\n`;
  text += `出发：**${data.origin}** | 舱位：**${data.cabin === 'business' ? '商务舱 J' : data.cabin}**\n`;
  text += `查询区间：${data.startDate} ~ ${data.endDate}\n\n`;

  if (!data.results || data.results.length === 0) {
    text += '**暂无可用积分商务舱位** （所有目的地）\n';
    return text;
  }

  data.results.forEach(r => {
    text += `### ✈️ ${r.destination} (${r.airport}) — 共 ${r.count} 个可用日期\n`;
    r.dates.forEach(d => {
      const avail = d.j ? '✅J' : '❌J';
      const seats = d.seats ? ` (${d.seats}席)` : '';
      text += `  • ${d.date}：${avail}${seats}\n`;
    });
    text += '\n';
  });
  return text;
}

module.exports = { searchFlights, formatFlightText, DEST_AIRPORTS };
