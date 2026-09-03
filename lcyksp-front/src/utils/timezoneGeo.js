// 零请求定位：只读 Intl 报出的时区名查表，查不到就用 UTC 偏移反推经度。
// 全程不触碰 geolocation 权限，不发任何请求。坐标保留 1 位小数（约 11 km），
// 对一个脉冲光点来说远够用，也让整张表压到 3 KB 出头。

// 按大区分组，省掉重复的前缀。城市名后面是 纬度,经度
const ZONES = {
  Africa: [
    'Abidjan:5.3,-4 Accra:5.6,-0.2 Addis_Ababa:9,38.7 Algiers:36.8,3.1 Cairo:30,31.2',
    'Casablanca:33.6,-7.6 Dakar:14.7,-17.4 Dar_es_Salaam:-6.8,39.3 Harare:-17.8,31',
    'Johannesburg:-26.2,28 Kampala:0.3,32.6 Khartoum:15.6,32.5 Kinshasa:-4.3,15.3',
    'Lagos:6.5,3.4 Luanda:-8.8,13.2 Maputo:-25.9,32.6 Nairobi:-1.3,36.8',
    'Tripoli:32.9,13.2 Tunis:36.8,10.2',
  ],
  America: [
    'Anchorage:61.2,-149.9 Argentina/Buenos_Aires:-34.6,-58.4 Bogota:4.7,-74.1',
    'Buenos_Aires:-34.6,-58.4 Caracas:10.5,-66.9 Chicago:41.9,-87.6 Costa_Rica:9.9,-84.1',
    'Denver:39.7,-105 Detroit:42.3,-83 Edmonton:53.5,-113.5 Guatemala:14.6,-90.5',
    'Halifax:44.6,-63.6 Havana:23.1,-82.4 La_Paz:-16.5,-68.1 Lima:-12,-77',
    'Los_Angeles:34.1,-118.2 Mexico_City:19.4,-99.1 Montevideo:-34.9,-56.2',
    'New_York:40.7,-74 Panama:9,-79.5 Phoenix:33.4,-112.1 Puerto_Rico:18.5,-66.1',
    'Santiago:-33.5,-70.7 Santo_Domingo:18.5,-69.9 Sao_Paulo:-23.5,-46.6',
    'Toronto:43.7,-79.4 Vancouver:49.3,-123.1 Winnipeg:49.9,-97.1',
  ],
  Asia: [
    'Almaty:43.2,76.9 Amman:31.9,35.9 Ashgabat:37.9,58.4 Baghdad:33.3,44.4 Baku:40.4,49.9',
    'Bangkok:13.8,100.5 Beirut:33.9,35.5 Bishkek:42.9,74.6 Brunei:4.9,114.9',
    'Calcutta:22.6,88.4 Chongqing:29.6,106.6 Colombo:6.9,79.9 Damascus:33.5,36.3',
    'Dhaka:23.8,90.4 Doha:25.3,51.5 Dubai:25.2,55.3 Dushanbe:38.5,68.8 Harbin:45.8,126.6',
    'Ho_Chi_Minh:10.8,106.7 Hong_Kong:22.3,114.2 Irkutsk:52.3,104.3 Jakarta:-6.2,106.8',
    'Jayapura:-2.5,140.7 Jerusalem:31.8,35.2 Kabul:34.5,69.2 Karachi:24.9,67',
    'Kathmandu:27.7,85.3 Kolkata:22.6,88.4 Krasnoyarsk:56,92.9 Kuala_Lumpur:3.1,101.7',
    'Kuwait:29.4,48 Macau:22.2,113.5 Makassar:-5.1,119.4 Manila:14.6,121',
    'Muscat:23.6,58.6 Novosibirsk:55,82.9 Phnom_Penh:11.6,104.9 Pyongyang:39,125.8',
    'Rangoon:16.8,96.2 Riyadh:24.7,46.7 Saigon:10.8,106.7 Seoul:37.6,127',
    'Shanghai:31.2,121.5 Singapore:1.3,103.8 Taipei:25,121.6 Tashkent:41.3,69.2',
    'Tbilisi:41.7,44.8 Tehran:35.7,51.4 Tokyo:35.7,139.7 Ulaanbaatar:47.9,106.9',
    'Urumqi:43.8,87.6 Vientiane:18,102.6 Vladivostok:43.1,131.9 Yangon:16.8,96.2',
    'Yekaterinburg:56.8,60.6 Yerevan:40.2,44.5',
  ],
  Atlantic: ['Azores:37.7,-25.7 Canary:28.1,-15.4 Reykjavik:64.1,-21.9'],
  Australia: [
    'Adelaide:-34.9,138.6 Brisbane:-27.5,153 Darwin:-12.5,130.8 Hobart:-42.9,147.3',
    'Melbourne:-37.8,145 Perth:-32,115.9 Sydney:-33.9,151.2',
  ],
  Europe: [
    'Amsterdam:52.4,4.9 Athens:38,23.7 Belgrade:44.8,20.5 Berlin:52.5,13.4',
    'Brussels:50.8,4.4 Bucharest:44.4,26.1 Budapest:47.5,19 Copenhagen:55.7,12.6',
    'Dublin:53.3,-6.3 Helsinki:60.2,24.9 Istanbul:41,29 Kiev:50.5,30.5 Kyiv:50.5,30.5',
    'Lisbon:38.7,-9.1 London:51.5,-0.1 Madrid:40.4,-3.7 Minsk:53.9,27.6 Moscow:55.8,37.6',
    'Oslo:59.9,10.8 Paris:48.9,2.4 Prague:50.1,14.4 Riga:56.9,24.1 Rome:41.9,12.5',
    'Sofia:42.7,23.3 Stockholm:59.3,18.1 Tallinn:59.4,24.8 Vienna:48.2,16.4',
    'Vilnius:54.7,25.3 Warsaw:52.2,21 Zagreb:45.8,16 Zurich:47.4,8.5',
  ],
  Indian: ['Maldives:4.2,73.5 Mauritius:-20.2,57.5'],
  Pacific: [
    'Auckland:-36.9,174.8 Fiji:-18.1,178.4 Guam:13.5,144.8 Honolulu:21.3,-157.9',
    'Port_Moresby:-9.5,147.2',
  ],
}

// 表里没有的时区，纬度退回大区的人口重心；经度另有 UTC 偏移可用，不必猜
const REGION_LAT = {
  Africa: 5,
  America: 35,
  Antarctica: -70,
  Arctic: 78,
  Asia: 30,
  Atlantic: 30,
  Australia: -30,
  Europe: 50,
  Indian: -10,
  Pacific: -15,
}

const TABLE = new Map([
  ['UTC', [0, 0]],
  ['Etc/UTC', [0, 0]],
  ['Etc/GMT', [0, 0]],
])
for (const [region, lines] of Object.entries(ZONES)) {
  for (const entry of lines.join(' ').split(' ')) {
    const cut = entry.lastIndexOf(':')
    const [lat, lon] = entry.slice(cut + 1).split(',')
    TABLE.set(`${region}/${entry.slice(0, cut)}`, [Number(lat), Number(lon)])
  }
}

const wrapLon = (x) => (((x + 180) % 360) + 360) % 360 - 180

export function detectTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

// 返回 { lat, lon, zone, source }。source 为 'zone' 表示查表命中，
// 'offset' 表示只能靠时区偏移估经度，调用方可以据此决定光点画多大
export function resolveViewerLocation(zone = detectTimezone()) {
  const hit = TABLE.get(zone)
  if (hit) return { lat: hit[0], lon: hit[1], zone, source: 'zone' }

  const region = zone.split('/')[0]
  const offsetHours = -new Date().getTimezoneOffset() / 60
  return {
    lat: REGION_LAT[region] ?? 20,
    lon: wrapLon(offsetHours * 15),
    zone,
    source: 'offset',
  }
}
