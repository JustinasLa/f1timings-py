/* Static configuration: colors, track parameters, and polling constants. */

const FETCH_INTERVAL_MS = 100;
const DRIVER_DOT_RADIUS = 10;

const TEAM_COLORS = {
  'Mercedes-AMG Petronas F1 Team': '#00D2BE',
  'Scuderia Ferrari': '#DC0000',
  'Oracle Red Bull Racing': '#0600EF',
  'Williams Racing': '#005AFF',
  'Aston Martin Aramco F1 Team': '#006F62',
  'BWT Alpine F1 Team': '#0090FF',
  'Visa Cash App RB F1 Team': '#2B4562',
  'MoneyGram Haas F1 Team': '#FFFFFF',
  'McLaren F1 Team': '#FF8700',
  'Stake F1 Team Kick Sauber': '#52E252',
  
  // Simulators: the team name says which sim the lap came from.
  'nhlstendensim': '#1E78FF',
  'nhlstendensim2': '#FF8700',

  'DEFAULT': '#a371f7'
};
const INSTANCE_COLORS = ['#1E78FF', '#FF8700'];

// Per-track map render settings. Fields:
//   d              - divisor that scales the raw coordinates down
//   x_offset       - shift of the whole map along the horizontal axis
//   z_offset       - shift of the whole map along the vertical axis
//   driver_x_offset/driver_z_offset - nudge to line live driver dots onto the track
//   rotation       - OPTIONAL: turn the whole map (and the driver dots) by this
//                    many degrees, clockwise on screen. Leave it out or set 0 for
//                    no rotation. The driver offsets rotate with the map, so you
//                    do NOT need to retune them when you change this.
//                    Example: set rotation:90 on monaco to turn Monaco a quarter turn.
const TRACK_DICTIONARY = {
  'abu_dhabi':        { d:2,   x_offset:800, z_offset:400, driver_x_offset:-115, driver_z_offset:45, rotation: 25 },
  'australia':        { d:3.5, x_offset:800, z_offset:400, rotation: -45 },
  'austria':          { d:2,   x_offset:800, z_offset:400, driver_x_offset:-52,  driver_z_offset:48, rotation: -10 },
  'azerbaijan':       { d:3,   x_offset:800, z_offset:400, driver_x_offset:50,   driver_z_offset:52, rotation: 50 },
  'bahrain':          { d:2,   x_offset:800, z_offset:400, rotation: 267 },
  'belgium':          { d:1.5, x_offset:800, z_offset:400, driver_x_offset:15,   driver_z_offset:-5, rotation: -90 },
  'brazil':           { d:2,   x_offset:800, z_offset:300, driver_x_offset:120,  driver_z_offset:-90, rotation: 75 },
  'canada':           { d:3,   x_offset:800, z_offset:200, driver_x_offset:-40,  driver_z_offset:-170, rotation: 120 },
  'china':            { d:2,   x_offset:800, z_offset:400, rotation: 123 },
  'great_britain':    { d:3.5, x_offset:800, z_offset:400, rotation: -100 },
  'hungary':          { d:2.5, x_offset:800, z_offset:400, driver_x_offset:25,   driver_z_offset: 5, rotation: 52 },
  'imola':            { d:2,   x_offset:800, z_offset:400, driver_x_offset:0,    driver_z_offset:-5, rotation: -5},
  'japan':            { d:2.5, x_offset:800, z_offset:400 },
  'las_vegas':        { d:4,   x_offset:800, z_offset:400, driver_x_offset:0,    driver_z_offset:10, rotation: -90 },
  'mexico':           { d:3.5, x_offset:800, z_offset:600, driver_x_offset:75,   driver_z_offset:140, rotation: -30 },
  'miami':            { d:2,   x_offset:800, z_offset:400, rotation: -2 },
  'monaco':           { d:2,   x_offset:800, z_offset:400, driver_x_offset:-7,   driver_z_offset:-12, rotation:30 },
  'monza':            { d:4,   x_offset:800, z_offset:400, rotation: -95 },
  'netherlands':      { d:2,   x_offset:800, z_offset:400, driver_x_offset:-5,   driver_z_offset:0, rotation: 185 },
  'portugal':         { d:2,   x_offset:800, z_offset:400, driver_x_offset:25,   driver_z_offset:30, rotation: 196 },
  'qatar':            { d:2.5, x_offset:800, z_offset:400, rotation: -61 },
  'saudi_arabia':     { d:4,   x_offset:800, z_offset:400, rotation: -120 },
  'singapore':        { d:1,   x_offset:800, z_offset:400, driver_x_offset:-8,   driver_z_offset:-26 },
  'spain':            { d:2.5, x_offset:800, z_offset:400, driver_x_offset:15,   driver_z_offset:7, rotation: 58 },
  'texas':            { d:2,   x_offset:800, z_offset:200, driver_x_offset:-45,  driver_z_offset:-250 },
};

const TRACK_DISPLAY_NAMES = {
  'abu_dhabi':'Abu Dhabi','australia':'Australia','austria':'Austria','azerbaijan':'Azerbaijan',
  'bahrain':'Bahrain','belgium':'Belgium','brazil':'Brazil','canada':'Canada',
  'china':'China','great_britain':'Great Britain','hungary':'Hungary','imola':'Imola',
  'japan':'Japan','las_vegas':'Las Vegas','mexico':'Mexico','miami':'Miami',
  'monaco':'Monaco','monza':'Monza','netherlands':'Netherlands','portugal':'Portugal',
  'qatar':'Qatar','saudi_arabia':'Saudi Arabia','singapore':'Singapore','spain':'Spain',
  'texas':'Texas'
};

const TRACK_COUNTRY_CODES = {
  'abu_dhabi': 'AE',
  'australia': 'AU',
  'austria': 'AT',
  'azerbaijan': 'AZ',
  'bahrain': 'BH',
  'belgium': 'BE',
  'brazil': 'BR',
  'canada': 'CA',
  'china': 'CN',
  'great_britain': 'GB',
  'hungary': 'HU',
  'imola': 'IT',
  'japan': 'JP',
  'las_vegas': 'US',
  'mexico': 'MX',
  'miami': 'US',
  'monaco': 'MC',
  'monza': 'IT',
  'netherlands': 'NL',
  'portugal': 'PT',
  'qatar': 'QA',
  'saudi_arabia': 'SA',
  'singapore': 'SG',
  'spain': 'ES',
  'texas': 'US'
};
