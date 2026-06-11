const crypto = require('crypto');

function ipHash(ip) {
  return crypto.createHash('sha256').update(ip + 'sbsalt2026').digest('hex').slice(0, 16);
}

// 内存缓存：同一 IP 1小时内只查一次，避免 ipapi.co 每日1000次限额耗尽
const geoCache = new Map();

async function geoLocate(ip) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return { country: 'LOCAL', region_code: 'GLOBAL', city: 'Local' };
  }
  const cached = geoCache.get(ip);
  if (cached && cached.expires > Date.now()) return cached.data;

  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`https://ipapi.co/${ip}/json/`, { timeout: 4000 });
    const data = await res.json();
    if (data.error) throw new Error(data.reason || 'geo error');
    const country = data.country_code || 'GLOBAL';
    const city = data.city || '';
    let region_code = 'GLOBAL';
    if (country === 'US') {
      const state = data.region_code || '';
      const eastStates    = ['NY','NJ','PA','MA','CT','RI','VT','NH','ME','MD','DC','DE','VA','WV'];
      const southStates   = ['FL','GA','SC','NC','TN','AL','MS','LA','AR','TX','OK'];
      const centralStates = ['IL','IN','OH','MI','WI','MN','IA','MO','ND','SD','NE','KS'];
      const westStates    = ['CA','WA','OR','NV','AZ','ID','MT','WY','UT','CO','NM','HI','AK'];
      if      (eastStates.includes(state))    region_code = 'US-EAST';
      else if (southStates.includes(state))   region_code = 'US-SOUTH';
      else if (centralStates.includes(state)) region_code = 'US-CENTRAL';
      else if (westStates.includes(state))    region_code = 'US-WEST';
      else                                    region_code = 'US-NORTH';
    } else if (country === 'CA') {
      const prov = data.region_code || '';
      if      (['BC','AB'].includes(prov))                        region_code = 'CA-WEST';
      else if (['ON','QC','NB','NS','PE','NL'].includes(prov))    region_code = 'CA-EAST';
      else                                                        region_code = 'CA-CENTRAL';
    } else if (country === 'CN') region_code = 'CN';
    else if (country === 'TW')   region_code = 'TW';
    else if (country === 'HK')   region_code = 'HK';

    const result = { country, region_code, city };
    if (geoCache.size > 5000) {
      const half = [...geoCache.keys()].slice(0, 2500);
      half.forEach(k => geoCache.delete(k));
    }
    geoCache.set(ip, { data: result, expires: Date.now() + 3_600_000 });
    return result;
  } catch {
    if (cached) return cached.data;
    return { country: 'GLOBAL', region_code: 'GLOBAL', city: '' };
  }
}

module.exports = { ipHash, geoLocate };
