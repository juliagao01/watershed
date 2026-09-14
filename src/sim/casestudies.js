/* Watershed — Case studies. Real Colorado events unlocked by what the player just experienced.
   Exports WS.CaseStudies = { LIST, byId(id), checkUnlocks(state, world), linkTo(id, state), pickQuiz(state, rng) }. Runs in Node (no DOM).
   Figures are deliberately approximate ("about", "roughly") and conservative. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};
  var C = WS.C;
  var fmt = C.fmt;
  var H = C.HYDRO;

  // ---------------------------------------------------------------- helpers
  function fin(v, d) { v = Number(v); return isFinite(v) ? v : (d == null ? 0 : d); }
  function obj(o) { return (o && typeof o === 'object') ? o : {}; }
  function arr(a) { return Array.isArray(a) ? a : []; }
  function acres(v) { return Math.round(fin(v)).toLocaleString() + ' acres'; }
  function fires(state) { return arr(obj(obj(state).fire).fires).map(obj); }
  function stats(state) { return obj(obj(state).stats); }
  function flags(state) { return obj(obj(state).flags); }
  function climate(state) { return obj(obj(state).climate); }
  function water(state) { return obj(obj(state).water); }
  function funded(state, id) {
    var f = obj(obj(obj(state).projects).funded)[id];
    return !!(f && (f.level == null || fin(f.level) > 0));
  }
  function effects(state) {
    try { if (WS.Projects && typeof WS.Projects.effects === 'function') return obj(WS.Projects.effects(state)); } catch (e) { /* ignore */ }
    return {};
  }
  function droughtLevel(state) {
    var m = /D([0-4])/.exec(String(climate(state).drought || ''));
    return m ? Number(m[1]) + 1 : 0;
  }
  function zoneTypes(world) {
    var map = {};
    arr(obj(world).zones).forEach(function (z) { if (z && z.id != null) map[z.id] = z.type; });
    return map;
  }
  function biggestFire(state) {
    var best = null;
    fires(state).forEach(function (f) { if (!best || fin(f.acres) > fin(best.acres)) best = f; });
    return best;
  }
  function fireTouchedNeighborhood(state, world) {
    var types = zoneTypes(world), hit = false;
    fires(state).forEach(function (f) { arr(f.zoneIds).forEach(function (id) { if (types[id] === 'neighborhood') hit = true; }); });
    return hit;
  }
  function totalStructures(state) {
    var n = fin(obj(obj(state).fire).structuresLost);
    fires(state).forEach(function (f) { n = Math.max(n, fin(f.structures)); });
    return n;
  }
  function householdShortagePct(state) {
    var w = water(state), d = fin(obj(w.demands).households), s = fin(obj(w.shortage).households);
    return d > 0 ? 100 * s / d : 0;
  }
  function legalOverride(state) {
    var st = obj(state), fl = flags(state), w = water(state), al = obj(w.alloc);
    if (fl.legalOverride || fin(fl.legalOverrides) > 0) return true;
    if (obj(st.lastSeasonReport).legalOverride) return true;
    if (fin(al.tribal, 1) < 0.999 || fin(al.downstream, 1) < 0.999) return true;
    return false;
  }
  function musselEvent(state) {
    var fl = flags(state);
    return !!(fl.musselEvent || fl.musselDetected || fl.musselInspection || fl.musselsFound || funded(state, 'mussel_inspection'));
  }
  function wetlandRestored(state) {
    return !!(flags(state).wetlandRestored || effects(state).wetlandRestored || funded(state, 'wetland'));
  }
  function contaminationOutage(state) {
    return fin(stats(state).contaminationOutageDays) > 0 || fin(flags(state).contaminationEvents) > 0 || fin(obj(obj(state).reservoir).ashContam) > 0.35;
  }

  // ---------------------------------------------------------------- list
  var LIST = [
    {
      id: 'cameron_peak', title: 'Cameron Peak Fire', year: 2020, region: 'Larimer County, Cache la Poudre watershed',
      summary: 'The Cameron Peak Fire started in August 2020 west of Fort Collins and burned into December, reaching about 208,000 acres, the largest wildfire in Colorado history. Much of it burned in the Cache la Poudre and Big Thompson watersheds that supply Fort Collins, Greeley and northern Colorado farms. In the following summers, storms over the burn scar sent ash, sediment and debris into the Poudre; a July 2021 debris flow in the canyon was deadly, and river turbidity spikes at times forced utilities to stop drawing from the river and rely on stored water. Recovery work, including mulching and stream restoration, has cost tens of millions of dollars and continues.',
      lesson: 'A watershed fire is a water-supply event lasting years.',
      unlock: function (state) { return fires(state).length >= 1; },
      linkTo: function (state) {
        var f = biggestFire(state);
        return f ? 'Your ' + acres(f.acres) + ' fire' + (f.upstream ? ' above the reservoir' : '') + ' left the same scar your water supply will remember.' : 'When a fire burns your upper sectors, this is what comes next.';
      }
    },
    {
      id: 'east_troublesome', title: 'East Troublesome Fire', year: 2020, region: 'Grand County and Rocky Mountain National Park',
      summary: 'In October 2020 the East Troublesome Fire, burning in drought-cured and beetle-killed lodgepole, exploded on strong winds and grew by roughly 100,000 acres in about a day, running some 17 miles toward Grand Lake and jumping the Continental Divide into Rocky Mountain National Park. It burned about 193,000 acres, the second-largest fire in state history, destroyed several hundred homes and killed two residents. Snow finally slowed it. It burned the headwaters of the Colorado River above Grand Lake and Shadow Mountain reservoirs, part of the Colorado-Big Thompson system that moves water to the Front Range.',
      lesson: 'In wind and dry fuel, fire outruns any response; prepare first.',
      unlock: function (state, world) {
        var big = false;
        fires(state).forEach(function (f) { if (fin(f.acres) >= 2000 && fin(f.structures) >= 1) big = true; });
        return big || totalStructures(state) >= 20 || fireTouchedNeighborhood(state, world);
      },
      linkTo: function (state) {
        var f = biggestFire(state);
        return f ? 'Your fire reached ' + acres(f.acres) + ' and ' + Math.round(fin(f.structures)) + ' structure' + (fin(f.structures) === 1 ? '' : 's') + '; East Troublesome ran 100,000 acres in a day.' : 'When a fast fire reaches homes, this is the comparison.';
      }
    },
    {
      id: 'marshall', title: 'Marshall Fire', year: 2021, region: 'Boulder County: Louisville, Superior and unincorporated areas',
      summary: 'On December 30, 2021, a grass fire driven by winds gusting over 100 mph tore through suburban Louisville, Superior and nearby neighborhoods in a few hours. It burned only about 6,000 acres but destroyed more than 1,000 homes and killed two people, making it the most destructive wildfire in Colorado history. The second half of 2021 had been unusually warm and dry, with almost no snow on the ground; snow fell the next day. Homes ignited from embers and from neighboring houses, not from a forest, and home-to-home spread did most of the damage.',
      lesson: 'Wildfire risk is wind, dry fuel and home construction, not only trees.',
      unlock: function (state, world) { return totalStructures(state) >= 20 || fireTouchedNeighborhood(state, world); },
      linkTo: function (state) {
        var n = totalStructures(state);
        return 'You lost ' + Math.round(n) + ' structure' + (n === 1 ? '' : 's') + ' to fire; Marshall lost 1,000 homes because houses became the fuel.';
      }
    },
    {
      id: 'colorado_river', title: 'Colorado River shortage and the 1922 Compact', year: 2022, region: 'Colorado River Basin, seven states and Mexico',
      summary: 'The Colorado River supplies roughly 40 million people and millions of irrigated acres. The 1922 Colorado River Compact divided about 15 million acre-feet a year between the Upper and Lower Basins based on an unusually wet period; the river has averaged well below that in the 21st century. Colorado, an Upper Basin state, must help ensure deliveries at Lee Ferry. After two decades of drought and warming, Lake Powell and Lake Mead fell to record lows in 2022, near a quarter full, threatening hydropower and forcing the first federal shortage declarations and emergency cuts.',
      lesson: 'Over-promised rivers make every local shortage a downstream obligation.',
      unlock: function (state) { return householdShortagePct(state) > 0.5 || droughtLevel(state) >= 3 || fin(flags(state).droughtDeclared) > 0 || flags(state).droughtDeclared === true; },
      linkTo: function (state) {
        var sp = fin(climate(state).snowpackPct, 100), d = climate(state).drought || 'None';
        return 'Snowpack ' + fmt.pct(sp) + ', drought ' + d + ', yet ' + fmt.af(H.DOWNSTREAM_AF_YR) + ' yearly must pass the dam: the Compact locally.';
      }
    },
    {
      id: 'shoshone', title: 'The Shoshone water right', year: 1902, region: 'Glenwood Canyon, Colorado River',
      summary: 'The Shoshone hydroelectric plant in Glenwood Canyon holds one of the most senior large water rights on the Colorado River in Colorado, with a priority dating to 1902 for about 1,250 cfs. It is non-consumptive: water runs through the turbines and returns to the river. When the plant places a "call", upstream junior rights, including some Front Range transmountain diversions, must let water pass, keeping flows through the canyon for fish, rafting and West Slope users. In an agreement announced in late 2023 and advanced through 2024, the Colorado River Water Conservation District moved to buy the rights from Xcel Energy for roughly $99 million to keep that water in the river permanently.',
      lesson: 'Seniority, not need, decides water in a dry year.',
      unlock: function (state) { return legalOverride(state); },
      linkTo: function (state) {
        var al = obj(water(state).alloc);
        var t = fin(al.tribal, 1), d = fin(al.downstream, 1);
        return 'Tribal set ' + fmt.pct(t * 100) + ', downstream ' + fmt.pct(d * 100) + '; like a Shoshone call, ' + fmt.af(H.TRIBAL_RIGHT_AF_YR) + ' is delivered regardless.';
      }
    },
    {
      id: 'monitoring', title: 'Streamgages and SNOTEL', year: 2024, region: 'Colorado and the western United States',
      summary: 'Colorado\'s water decisions rest on two measurement networks. The U.S. Geological Survey and the Colorado Division of Water Resources operate hundreds of streamgages in the state, most reporting near real time, and the USGS runs more than 8,000 gauges nationwide. The Natural Resources Conservation Service SNOTEL network of roughly 800 automated mountain sites, more than 100 of them in Colorado, measures snow water equivalent, the basis of the April 1 runoff forecasts that ditch companies, cities and the state engineer plan around. Gauges also administer water rights, warn of floods and record post-fire sediment pulses.',
      lesson: 'You cannot manage what you do not measure; gauges are cheapest.',
      unlock: function (state) { return funded(state, 'streamgages') || fin(effects(state).sensorCoverage) > 0; },
      linkTo: function (state) {
        var u = fin(climate(state).uncertainty, 0.25);
        return 'Your forecast uncertainty is ±' + fmt.pct(u * 100) + ' with gauges; SNOTEL does the same for the April 1 forecast.';
      }
    },
    {
      id: 'mussels', title: 'Invasive mussel prevention', year: 2022, region: 'Highline Lake and the Colorado River near Grand Junction',
      summary: 'Zebra and quagga mussels, spread mainly on trailered boats, coat intakes, pipes and hydropower works and can cost utilities millions to manage. Colorado Parks and Wildlife has run mandatory boat inspection and decontamination at reservoirs since 2008, performing hundreds of thousands of inspections a year. Colorado kept adult populations out for years, but in 2022 adult zebra mussels were confirmed in Highline Lake near Grand Junction, the state\'s first, and the lake was drained in an attempt to eradicate them. In 2024 zebra mussels were found in the Colorado River itself near Grand Junction and in an irrigation canal.',
      lesson: 'Prevention costs yearly; an established invader costs forever.',
      unlock: function (state) { return musselEvent(state); },
      linkTo: function (state) {
        return funded(state, 'mussel_inspection') ? 'Your inspection stations are Colorado\'s program; $0.3M upkeep keeps the intake clear.' : 'A mussel scare reached your reservoir; without inspections, 1 fouled intake is likely.';
      }
    },
    {
      id: 'hayman', title: 'Hayman Fire and Denver Water\'s sediment bill', year: 2002, region: 'South Platte watershed, Upper South Platte',
      summary: 'The Hayman Fire of June 2002 burned about 138,000 acres in the Upper South Platte, then the largest fire in Colorado history, upstream of Denver Water\'s Cheesman and Strontia Springs reservoirs. Together with the 1996 Buffalo Creek Fire, it sent years of sediment into the reservoirs; Denver Water has reported spending on the order of $27 million on dredging Strontia Springs, treatment changes and watershed repair. The experience led to the From Forests to Faucets partnership with the U.S. Forest Service, begun in 2010, in which the utility co-funds forest thinning and restoration because it is cheaper than treating the water afterward.',
      lesson: 'A healthy forest upstream is water treatment paid in advance.',
      unlock: function (state) { return contaminationOutage(state); },
      linkTo: function (state) {
        var rv = obj(obj(state).reservoir), st = stats(state);
        return 'Turbidity ' + fmt.num(fin(rv.turbidity) * 100) + '%, ash ' + fmt.num(fin(rv.ashContam) * 100) + '%, ' + Math.round(fin(st.contaminationOutageDays)) + ' outage days; Denver Water paid $27M, then funded thinning.';
      }
    },
    {
      id: 'buffalo_creek', title: 'Buffalo Creek: flood after fire', year: 1996, region: 'Jefferson County, Upper South Platte',
      summary: 'In May 1996 the Buffalo Creek Fire burned about 12,000 acres of ponderosa pine southwest of Denver. Two months later, on July 12, a thunderstorm dropped roughly two inches of rain in under an hour on the bare, water-repellent scar. The flash flood tore through the small town of Buffalo Creek, killed two people, destroyed homes and roads, and carried an enormous slug of sediment into Strontia Springs Reservoir, by some estimates more than the reservoir had received in the previous decades combined. It became the textbook Colorado example of why a burn scar is a flood hazard.',
      lesson: 'The most dangerous storm is an ordinary one on a fresh scar.',
      unlock: function (state) { return fin(stats(state).sedimentTons) > 0 && fires(state).length >= 1; },
      linkTo: function (state) {
        var st = stats(state);
        return 'Your storm moved ' + Math.round(fin(st.sedimentTons)).toLocaleString() + ' t of sediment and cost ' + fmt.money(fin(st.floodDamageM)) + '; Buffalo Creek was steeper.';
      }
    },
    {
      id: 'grizzly_creek', title: 'Grizzly Creek Fire and the Glenwood Canyon debris flows', year: 2021, region: 'Glenwood Canyon, Interstate 70',
      summary: 'The Grizzly Creek Fire of August 2020 burned about 32,000 acres of steep canyon walls above Interstate 70 in Glenwood Canyon and closed the highway for roughly two weeks. The following summer, monsoon rains over the burn scar triggered repeated debris flows; in late July 2021 mud and boulders buried sections of I-70, trapping motorists overnight, and the interstate stayed closed for about two weeks while crews cleared and rebuilt. Glenwood Springs temporarily lost use of creek intakes fouled by ash and switched to other supplies. Repairs ran to tens of millions of dollars.',
      lesson: 'Debris flows follow drainages; everything below a scar is in the path.',
      unlock: function (state) { return fires(state).length >= 1 && fin(stats(state).floodDamageM) > 0.5; },
      linkTo: function (state) {
        var st = stats(state);
        return 'Your post-fire storm cost ' + fmt.money(fin(st.floodDamageM)) + '; the same flow shut I-70 for 2 weeks.';
      }
    },
    {
      id: 'flood_2013', title: 'The 2013 Front Range flood', year: 2013, region: 'Boulder, Larimer, Weld and neighboring counties',
      summary: 'From September 9 to 16, 2013, a stalled moist air mass dropped extraordinary rain on the Front Range; Boulder recorded roughly 17 inches in a week, close to its normal annual total. Creeks from the Big Thompson to Boulder Creek left their banks, destroying about 1,800 homes, damaging many thousands more, washing out hundreds of miles of roads and killing at least eight people. Damage was estimated in the billions of dollars, and rebuilding the canyon highways took years. Areas below the 2010 Fourmile Canyon burn scar saw especially heavy sediment.',
      lesson: 'Warnings, setbacks and room for the river beat walls.',
      unlock: function (state) { return fin(stats(state).floodDamageM) >= 3; },
      linkTo: function (state) {
        var st = stats(state);
        return 'Your flood damage totals ' + fmt.money(fin(st.floodDamageM)) + '; 2013 hit every Front Range drainage in one week.';
      }
    },
    {
      id: 'beaver_mimicry', title: 'Beaver mimicry and wetland restoration', year: 2020, region: 'Headwater meadows across Colorado',
      summary: 'Across the West, land managers are rebuilding wet meadows with beaver dam analogs, hand-built structures of posts and willow that slow streams the way beaver dams do, and by reintroducing beavers themselves. Ponded water raises the water table, stores runoff into late summer, traps sediment and cools the stream. Research published in 2020 found that beaver-dammed riparian corridors stayed green through wildfires while surrounding areas burned. Colorado projects, from Rocky Mountain National Park meadows scarred by the East Troublesome Fire to ranch creeks on the West Slope, use this low-cost approach to buffer drought, fire and post-fire floods.',
      lesson: 'Slowing headwater flow is storage, flood control and habitat at once.',
      unlock: function (state) { return wetlandRestored(state); },
      linkTo: function (state) {
        var rv = obj(obj(state).reservoir);
        return 'Your wetland traps a third of sediment and cuts peaks 30%; storage is ' + fmt.af(fin(rv.storageAF)) + '.';
      }
    }
  ];

  // ---------------------------------------------------------------- field quiz bank (2 questions per case; q ≤ 20 words, options ≤ 8, why ≤ 16)
  // Figures repeat the summaries above; nothing here is more precise than its source.
  var QUIZ = {
    cameron_peak: [
      { q: 'Roughly how large was the 2020 Cameron Peak Fire?', options: ['About 20,000 acres', 'About 208,000 acres', 'About 2 million acres'], answer: 1, why: 'About 208,000 acres, the largest wildfire in Colorado history.' },
      { q: 'What did storms over the Cameron Peak burn scar do to the Poudre River?', options: ['Sent ash and sediment into intakes', 'Raised the snowpack', 'Nothing measurable'], answer: 0, why: 'Ash and debris in 2021 forced utilities to stop drawing river water.' }
    ],
    east_troublesome: [
      { q: 'In October 2020, how far did East Troublesome run in about a day?', options: ['About 2 miles', 'About 17 miles', 'About 90 miles'], answer: 1, why: 'Some 17 miles, growing about 100,000 acres in a single day.' },
      { q: 'What finally slowed the East Troublesome Fire?', options: ['Snowfall', 'A dozer line', 'The Continental Divide'], answer: 0, why: 'Snow slowed it after it jumped the Divide; about 193,000 acres burned.' }
    ],
    marshall: [
      { q: 'What carried the Marshall Fire on December 30, 2021?', options: ['Dense mountain forest', 'Wind-driven grass, then homes', 'Beetle-killed lodgepole'], answer: 1, why: 'A wind-driven grass fire; homes ignited homes, more than 1,000 destroyed.' },
      { q: 'About how many homes did the Marshall Fire destroy?', options: ['About 100', 'More than 1,000', 'About 10,000'], answer: 1, why: 'More than 1,000 homes on only about 6,000 acres: Colorado\'s most destructive.' }
    ],
    colorado_river: [
      { q: 'Roughly how many people rely on the Colorado River?', options: ['About 4 million', 'About 40 million', 'About 400 million'], answer: 1, why: 'Roughly 40 million people across seven states and Mexico.' },
      { q: 'What did the 1922 Colorado River Compact do?', options: ['Split the river between two basins', 'Built Hoover Dam', 'Banned irrigation in Colorado'], answer: 0, why: 'It divided about 15 million acre-feet a year between Upper and Lower Basins.' }
    ],
    shoshone: [
      { q: 'How old is the Shoshone hydro plant\'s senior water right?', options: ['It dates to 1902', 'It dates to 1972', 'It dates to 2023'], answer: 0, why: 'Priority date 1902, about 1,250 cfs, among the river\'s most senior rights.' },
      { q: 'Why is the Shoshone right called non-consumptive?', options: ['Water returns to the river after the turbines', 'It uses no water at all', 'It runs only in winter'], answer: 0, why: 'Water passes through turbines and returns; a call keeps 1,250 cfs flowing.' }
    ],
    monitoring: [
      { q: 'What does a SNOTEL site measure?', options: ['Snow water equivalent', 'Stream temperature', 'Boat traffic'], answer: 0, why: 'Snow water equivalent at roughly 800 mountain sites feeds April 1 forecasts.' },
      { q: 'About how many SNOTEL sites are in Colorado?', options: ['About 10', 'More than 100', 'About 5,000'], answer: 1, why: 'More than 100 of roughly 800 western SNOTEL sites are in Colorado.' }
    ],
    mussels: [
      { q: 'How do zebra and quagga mussels mostly spread between lakes?', options: ['On trailered boats', 'Carried by birds', 'Through groundwater'], answer: 0, why: 'Mainly on trailered boats; Colorado has inspected boats since 2008.' },
      { q: 'What happened at Highline Lake in 2022?', options: ['Adult zebra mussels were confirmed', 'The dam failed', 'It froze solid'], answer: 0, why: 'Colorado\'s first adult zebra mussels, 2022; the lake was drained to fight them.' }
    ],
    hayman: [
      { q: 'Where did Hayman Fire sediment end up?', options: ['Strontia Springs Reservoir', 'Lake Powell', 'The Arkansas River'], answer: 0, why: 'Sediment filled Strontia Springs; Denver Water spent about $27 million.' },
      { q: 'What did Denver Water start doing after Hayman?', options: ['Co-funding forest thinning upstream', 'Building a new dam', 'Abandoning the South Platte'], answer: 0, why: 'From Forests to Faucets, 2010: paying for thinning beats treating water later.' }
    ],
    buffalo_creek: [
      { q: 'What hit Buffalo Creek two months after its 1996 fire?', options: ['A flash flood', 'A second fire', 'A drought'], answer: 0, why: 'About 2 inches of rain in under an hour caused a deadly flash flood.' },
      { q: 'Why did an ordinary storm flood Buffalo Creek?', options: ['The burn scar shed water like pavement', 'The dam gates were opened', 'Snowmelt peaked early'], answer: 0, why: 'Bare, water-repellent soil after a 12,000-acre burn sent rain straight downhill.' }
    ],
    grizzly_creek: [
      { q: 'What closed Interstate 70 in Glenwood Canyon in summer 2021?', options: ['Debris flows off the burn scar', 'A rockslide from an earthquake', 'A record snowstorm'], answer: 0, why: 'Monsoon rain on the 2020 scar buried I-70 for about 2 weeks.' },
      { q: 'What did Glenwood Springs do when ash fouled its creek intakes?', options: ['Switched to other supplies', 'Shut off all water', 'Boiled the river'], answer: 0, why: 'It switched sources temporarily; Grizzly Creek burned about 32,000 acres above town.' }
    ],
    flood_2013: [
      { q: 'Roughly how much rain fell on Boulder in the September 2013 flood week?', options: ['About 2 inches', 'About 17 inches', 'About 60 inches'], answer: 1, why: 'Roughly 17 inches in a week, near Boulder\'s normal annual total.' },
      { q: 'About how many homes did the 2013 Front Range flood destroy?', options: ['About 18', 'About 1,800', 'About 180,000'], answer: 1, why: 'About 1,800 homes destroyed and at least 8 people killed.' }
    ],
    beaver_mimicry: [
      { q: 'What does a beaver dam analog do to a headwater stream?', options: ['Slows water and raises the water table', 'Speeds water to the reservoir', 'Blocks fish for good'], answer: 0, why: 'Slowed water raises the water table and stores runoff into late summer.' },
      { q: 'What did 2020 research find about beaver-dammed corridors during wildfires?', options: ['They stayed green while surroundings burned', 'They burned hottest', 'They dried up first'], answer: 0, why: 'A 2020 study found beaver-dammed corridors stayed green through wildfires.' }
    ]
  };
  LIST.forEach(function (cs) { cs.quiz = arr(QUIZ[cs.id]); });

  var BY_ID = {};
  LIST.forEach(function (cs) { BY_ID[cs.id] = cs; });

  // ---------------------------------------------------------------- field quiz: one question per season
  var FIRE_CASES = ['cameron_peak', 'east_troublesome', 'marshall', 'hayman', 'buffalo_creek', 'grizzly_creek'];
  var FLOOD_CASES = ['flood_2013', 'buffalo_creek', 'grizzly_creek', 'beaver_mimicry'];
  var DRY_CASES = ['colorado_river', 'shoshone', 'monitoring'];
  function questionId(cs, i) { return cs.id + ':' + i; }
  /* cases whose story matches what the season just did: fire → fire cases, a storm → flood cases, a dry year → river / rights / measurement */
  function relevantCases(state) {
    var st = obj(state), rep = obj(st.lastSeasonReport), out = [];
    if (rep.fire || fin(obj(st.fire).seasonAcres) > 0) out = out.concat(FIRE_CASES);
    if (rep.flood || rep.storm) out = out.concat(FLOOD_CASES);
    if (droughtLevel(state) >= 2 || fin(climate(state).snowpackPct, 100) < 80) out = out.concat(DRY_CASES);
    return out;
  }
  /** pickQuiz(state, rng) → { id, caseId, caseTitle, q, options, answer, why } | null.
      Prefers a case unlocked this season (state.quiz.lastUnlocked), then any unlocked case, then a case relevant to the season,
      else round-robin by turn. A question id (`caseId:index`) in state.quiz.asked is not repeated until every question has been asked.
      Option order is shuffled with `rng` (deterministic) and `answer` remapped. */
  function pickQuiz(state, rng) {
    state = obj(state);
    var quiz = obj(state.quiz), asked = arr(quiz.asked).map(String);
    var rnd = (rng && typeof rng.next === 'function') ? rng : null;
    function pick(list) { return list.length === 1 ? list[0] : list[rnd ? Math.floor(rnd.next() * list.length) : 0]; }
    function unasked(cs) { return arr(cs.quiz).map(function (q, i) { return i; }).filter(function (i) { return asked.indexOf(questionId(cs, i)) < 0; }); }
    function open(ids) { return ids.map(function (id) { return BY_ID[String(id)]; }).filter(function (cs) { return cs && unasked(cs).length > 0; }); }
    var all = LIST.filter(function (cs) { return arr(cs.quiz).length > 0; });
    if (!all.length) return null;
    var tiers = [arr(quiz.lastUnlocked), arr(state.unlockedCases), relevantCases(state)], cands = null, i;
    for (i = 0; i < tiers.length && !cands; i++) { var t = open(tiers[i]); if (t.length) cands = t; }
    var fresh = false;
    if (!cands) {
      var pool = all.filter(function (cs) { return unasked(cs).length > 0; });
      if (!pool.length) { pool = all; fresh = true; }   // every question asked: start over
      cands = [pool[Math.max(0, Math.round(fin(state.turn))) % pool.length]];
    }
    var cs = pick(cands);
    var idx = pick(fresh ? arr(cs.quiz).map(function (q, k) { return k; }) : unasked(cs));
    var q = obj(arr(cs.quiz)[idx]);
    var order = arr(q.options).map(function (o, k) { return k; });
    if (rnd) { for (var a = order.length - 1; a > 0; a--) { var b = Math.floor(rnd.next() * (a + 1)); var tmp = order[a]; order[a] = order[b]; order[b] = tmp; } }
    return { id: questionId(cs, idx), caseId: cs.id, caseTitle: cs.title, q: String(q.q || ''),
      options: order.map(function (k) { return String(q.options[k]); }), answer: Math.max(0, order.indexOf(fin(q.answer))), why: String(q.why || '') };
  }

  // ---------------------------------------------------------------- API
  function safeUnlock(cs, state, world) {
    try { return !!cs.unlock(state, world); } catch (e) { if (WS.DEBUG) console.error('Case unlock error', cs.id, e); return false; }
  }
  function linkTo(id, state) {
    var cs = BY_ID[id];
    if (!cs) return '';
    try { return String(cs.linkTo(obj(state))).replace(/\b(undefined|NaN)\b/g, '?'); } catch (e) { return 'Linked to what your valley just experienced.'; }
  }
  function checkUnlocks(state, world) {
    state = obj(state);
    if (!Array.isArray(state.unlockedCases)) state.unlockedCases = [];
    var newly = [];
    LIST.forEach(function (cs) {
      if (state.unlockedCases.indexOf(cs.id) >= 0) return;
      if (safeUnlock(cs, state, world)) { state.unlockedCases.push(cs.id); newly.push(cs.id); }
    });
    return newly;
  }

  WS.CaseStudies = {
    LIST: LIST,
    byId: function (id) { return BY_ID[id] || null; },
    checkUnlocks: checkUnlocks,
    linkTo: linkTo,
    pickQuiz: pickQuiz
  };
})();
