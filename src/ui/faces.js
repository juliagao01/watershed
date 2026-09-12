/* Watershed — Faces: deterministic 2-D "field-guide" portraits (Canvas 2D, paths only, no images/gradients).
   Exports WS.Faces = { OPTIONS, DEFAULT, PRESETS, LABELS, draw(canvas, spec, opts), dataURL(spec, size, opts), random(rng), normalize(spec), hexOf(kind, id) }.
   Loads before hud.js. Safe to load in Node (no DOM use until draw/dataURL is called). */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};

  var OPTIONS = {
    body: ['female', 'male'],
    skin: [{ id: 's1', hex: '#f6d3b8' }, { id: 's2', hex: '#e8b894' }, { id: 's3', hex: '#c98f66' }, { id: 's4', hex: '#a56a45' }, { id: 's5', hex: '#7a4a2e' }, { id: 's6', hex: '#4d2f1e' }],
    hair: ['short', 'buzz', 'curly', 'long', 'ponytail', 'bun', 'braids', 'bald', 'afro', 'wavy'],
    hairColor: [{ id: 'h1', hex: '#2b1d14' }, { id: 'h2', hex: '#5a3a22' }, { id: 'h3', hex: '#a3652f' }, { id: 'h4', hex: '#d9b06a' }, { id: 'h5', hex: '#b5b5b5' }, { id: 'h6', hex: '#c0392b' }],
    eyes: ['round', 'almond', 'narrow'],
    brows: ['soft', 'straight', 'arched'],
    mouth: ['smile', 'neutral', 'grin'],
    facialHair: ['none', 'stubble', 'beard', 'moustache'],
    glasses: ['none', 'round', 'square', 'sun'],
    hat: ['none', 'cap', 'widebrim', 'beanie', 'helmet', 'hardhat'],
    outfit: [{ id: 'o1', hex: '#2f6fb3' }, { id: 'o2', hex: '#c0392b' }, { id: 'o3', hex: '#2e8b57' }, { id: 'o4', hex: '#e2a93b' }, { id: 'o5', hex: '#6b4fbb' }, { id: 'o6', hex: '#444' }],
    accessory: ['none', 'clipboard', 'binoculars', 'radio', 'scarf']
  };
  var KEYS = Object.keys(OPTIONS);
  var DEFAULT = { body: 'female', skin: 's2', hair: 'short', hairColor: 'h2', eyes: 'round', brows: 'soft', mouth: 'smile', facialHair: 'none', glasses: 'none', hat: 'none', outfit: 'o1', accessory: 'none' };
  /** Human-readable labels for the creator UI. */
  var LABELS = {
    body: 'Body', skin: 'Skin', hair: 'Hair', hairColor: 'Hair colour', eyes: 'Eyes', brows: 'Brows', mouth: 'Mouth', facialHair: 'Facial hair', glasses: 'Glasses', hat: 'Hat', outfit: 'Outfit', accessory: 'Accessory',
    values: { female: 'Female', male: 'Male', short: 'Short', buzz: 'Buzz', curly: 'Curly', long: 'Long', ponytail: 'Ponytail', bun: 'Bun', braids: 'Braids', bald: 'Bald', afro: 'Afro', wavy: 'Wavy',
      round: 'Round', almond: 'Almond', narrow: 'Narrow', soft: 'Soft', straight: 'Straight', arched: 'Arched', smile: 'Smile', neutral: 'Neutral', grin: 'Grin',
      none: 'None', stubble: 'Stubble', beard: 'Beard', moustache: 'Moustache', square: 'Square', sun: 'Sunglasses', cap: 'Cap', widebrim: 'Wide brim', beanie: 'Beanie', helmet: 'Fire helmet', hardhat: 'Hard hat',
      clipboard: 'Clipboard', binoculars: 'Binoculars', radio: 'Radio', scarf: 'Scarf' }
  };
  var PRESETS = [
    { name: 'Ranger', face: { skin: 's3', hair: 'short', hairColor: 'h1', eyes: 'almond', brows: 'straight', mouth: 'smile', facialHair: 'none', glasses: 'none', hat: 'widebrim', outfit: 'o3', accessory: 'binoculars' } },
    { name: 'Engineer', face: { skin: 's2', hair: 'bun', hairColor: 'h2', eyes: 'round', brows: 'arched', mouth: 'neutral', facialHair: 'none', glasses: 'round', hat: 'hardhat', outfit: 'o4', accessory: 'clipboard' } },
    { name: 'Field scientist', face: { skin: 's4', hair: 'braids', hairColor: 'h1', eyes: 'round', brows: 'soft', mouth: 'grin', facialHair: 'none', glasses: 'none', hat: 'cap', outfit: 'o1', accessory: 'radio' } },
    { name: 'Fire chief', face: { skin: 's5', hair: 'buzz', hairColor: 'h1', eyes: 'narrow', brows: 'straight', mouth: 'neutral', facialHair: 'beard', glasses: 'none', hat: 'helmet', outfit: 'o2', accessory: 'radio' } }
  ];

  /* ------------------------------------------------------------------ colour helpers */
  function hexToRgb(hex) {
    var s = String(hex || '').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    if (!isFinite(n) || s.length !== 6) return [128, 128, 128];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbStr(c, a) { return a == null ? 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')' : 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function mix(hex, target, t) {
    var a = hexToRgb(hex), b = hexToRgb(target);
    return rgbStr([Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]);
  }
  function shade(hex, t) { return mix(hex, '#3a2418', t); }   /* warm shadow */
  function tint(hex, t) { return mix(hex, '#fff6e6', t); }    /* warm highlight */

  function findOpt(kind, id) {
    var list = OPTIONS[kind] || [];
    for (var i = 0; i < list.length; i++) { var o = list[i]; if ((typeof o === 'string' ? o : o.id) === id) return o; }
    return null;
  }
  function hexOf(kind, id) {
    var o = findOpt(kind, id) || OPTIONS[kind][0];
    return typeof o === 'string' ? '#888888' : o.hex;
  }
  function normalize(spec) {
    spec = (spec && typeof spec === 'object') ? spec : {};
    var out = {};
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i], v = spec[k];
      out[k] = (typeof v === 'string' && findOpt(k, v)) ? v : DEFAULT[k];
    }
    return out;
  }
  function random(rng) {
    var r = (rng && typeof rng.next === 'function') ? rng.next : (typeof rng === 'function' ? rng : Math.random);
    var pick = function (list) { return list[Math.floor(r() * list.length) % list.length]; };
    var idOf = function (o) { return typeof o === 'string' ? o : o.id; };
    var out = {};
    for (var i = 0; i < KEYS.length; i++) out[KEYS[i]] = idOf(pick(OPTIONS[KEYS[i]]));
    /* keep the option space plausible: most people have no hat / no facial hair / no glasses */
    if (r() < 0.45) out.hat = 'none';
    if (r() < 0.55) out.facialHair = 'none';
    if (r() < 0.5) out.glasses = 'none';
    if (r() < 0.35) out.accessory = 'none';
    return out;
  }

  /* ------------------------------------------------------------------ drawing (100×100 unit space) */
  var OUTLINE = '#3b2a1e';
  var HEAD = { cx: 50, cy: 44, rx: 21, ry: 24 };

  function ellipsePath(ctx, cx, cy, rx, ry) {
    ctx.beginPath();
    if (ctx.ellipse) ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    else { ctx.save(); ctx.translate(cx, cy); ctx.scale(rx, ry); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.restore(); }
    ctx.closePath();
  }
  var CUR_BODY = 'female';   /* set by draw() before any path is built */
  function headPath(ctx) {
    /* slightly narrower jaw than crown: a bezier head rather than a pure ellipse; the jaw is squarer for the male body type */
    var cx = HEAD.cx, top = HEAD.cy - HEAD.ry, bottom = HEAD.cy + HEAD.ry, male = CUR_BODY === 'male';
    var jw = male ? 22.5 : 20.5, jl = male ? 21.5 : 18.5, ch = male ? 14 : 10;
    ctx.beginPath();
    ctx.moveTo(cx, top);
    ctx.bezierCurveTo(cx + 17, top, cx + 23, 30, cx + jw, 46);
    ctx.bezierCurveTo(cx + jl, 60, cx + ch, bottom, cx, bottom);
    ctx.bezierCurveTo(cx - ch, bottom, cx - jl, 60, cx - jw, 46);
    ctx.bezierCurveTo(cx - 23, 30, cx - 17, top, cx, top);
    ctx.closePath();
  }
  function bodyPath(ctx) {
    var male = CUR_BODY === 'male';
    ctx.beginPath();
    if (male) {
      ctx.moveTo(3, 104); ctx.lineTo(5, 88);
      ctx.bezierCurveTo(7, 77, 20, 73, 36, 71.5); ctx.lineTo(64, 71.5);
      ctx.bezierCurveTo(80, 73, 93, 77, 95, 88); ctx.lineTo(97, 104);
    } else {
      ctx.moveTo(9, 104); ctx.lineTo(11, 91);
      ctx.bezierCurveTo(13, 80, 24, 76, 37, 74); ctx.lineTo(63, 74);
      ctx.bezierCurveTo(76, 76, 87, 80, 89, 91); ctx.lineTo(91, 104);
    }
    ctx.closePath();
  }
  /** Fill `pathFn` two-tone (base + warm shadow crescent offset by dx,dy) and outline it. */
  function twoTone(ctx, pathFn, base, dark, dx, dy, lw, noStroke) {
    ctx.save();
    pathFn(ctx); ctx.clip();
    ctx.fillStyle = dark; ctx.fillRect(-10, -10, 130, 130);
    ctx.translate(dx, dy);
    pathFn(ctx); ctx.fillStyle = base; ctx.fill();
    ctx.restore();
    if (!noStroke) { pathFn(ctx); ctx.lineWidth = lw; ctx.strokeStyle = OUTLINE; ctx.stroke(); }
  }
  function fillStroke(ctx, pathFn, fill, lw, strokeStyle) {
    pathFn(ctx);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (lw) { ctx.lineWidth = lw; ctx.strokeStyle = strokeStyle || OUTLINE; ctx.stroke(); }
  }

  /* hair volume that a hat must clear */
  var HAIR_LIFT = { afro: 7, curly: 3, wavy: 1, bun: 0 };

  /* ---- hair: behind the head (drawn after the body so long hair drapes over the shoulders) ---- */
  function hairBack(ctx, spec, hc, lw) {
    var dark = shade(hc, 0.28);
    switch (spec.hair) {
      case 'long':
        twoTone(ctx, function (c) {
          c.beginPath();
          c.moveTo(50, 19);
          c.bezierCurveTo(74, 19, 78, 40, 77, 58);
          c.bezierCurveTo(77, 72, 80, 82, 76, 92);
          c.lineTo(24, 92);
          c.bezierCurveTo(20, 82, 23, 72, 23, 58);
          c.bezierCurveTo(22, 40, 26, 19, 50, 19);
          c.closePath();
        }, hc, dark, -4, -3, lw);
        break;
      case 'wavy':
        twoTone(ctx, function (c) {
          c.beginPath();
          c.moveTo(50, 19);
          c.bezierCurveTo(72, 19, 78, 36, 76, 52);
          c.bezierCurveTo(80, 58, 74, 64, 79, 70);
          c.bezierCurveTo(73, 76, 79, 82, 72, 86);
          c.lineTo(28, 86);
          c.bezierCurveTo(21, 82, 27, 76, 21, 70);
          c.bezierCurveTo(26, 64, 20, 58, 24, 52);
          c.bezierCurveTo(22, 36, 28, 19, 50, 19);
          c.closePath();
        }, hc, dark, -4, -3, lw);
        break;
      case 'afro':
        twoTone(ctx, function (c) {
          c.beginPath();
          var n = 14, R = 33, cx = 50, cy = 39;
          for (var i = 0; i <= n; i++) {
            var a0 = (i / n) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 0.5) / n) * Math.PI * 2 - Math.PI / 2;
            var x0 = cx + Math.cos(a0) * R, y0 = cy + Math.sin(a0) * R * 0.98;
            var x1 = cx + Math.cos(a1) * (R + 4.5), y1 = cy + Math.sin(a1) * (R + 4.5) * 0.98;
            if (i === 0) c.moveTo(x0, y0); else c.quadraticCurveTo(px, py, x0, y0);
            var px = x1, py = y1;
          }
          c.closePath();
        }, hc, dark, -4, -3, lw);
        break;
      case 'curly':
        twoTone(ctx, function (c) {
          c.beginPath();
          var pts = [[29, 44], [24, 34], [27, 24], [36, 16], [50, 13], [64, 16], [73, 24], [76, 34], [71, 44]];
          c.moveTo(29, 52);
          for (var i = 0; i < pts.length; i++) c.arc(pts[i][0], pts[i][1], 7, 0, Math.PI * 2);
          c.lineTo(71, 52); c.lineTo(29, 52);
          c.closePath();
        }, hc, dark, -3, -2, lw);
        break;
      case 'ponytail':
        twoTone(ctx, function (c) {
          c.beginPath();
          c.moveTo(62, 26);
          c.bezierCurveTo(78, 24, 82, 44, 79, 58);
          c.bezierCurveTo(77, 70, 82, 80, 76, 88);
          c.bezierCurveTo(70, 84, 68, 72, 70, 62);
          c.bezierCurveTo(72, 48, 66, 40, 60, 34);
          c.closePath();
        }, hc, dark, -3, -2, lw);
        break;
      case 'bun':
        if (spec.hat === 'none') twoTone(ctx, function (c) { ellipsePath(c, 50, 15, 11, 9); }, hc, dark, -3, -2, lw);
        break;
      case 'braids':
        [30, 70].forEach(function (x) {
          twoTone(ctx, function (c) {
            c.beginPath();
            for (var i = 0; i < 6; i++) c.arc(x + (i % 2 ? 1.2 : -1.2), 46 + i * 7.5, 4.6, 0, Math.PI * 2);
            c.closePath();
          }, hc, dark, -2, -2, lw);
          /* tie */
          fillStroke(ctx, function (c) { ellipsePath(c, x, 86, 3.2, 1.8); }, '#c9a66b', lw * 0.7);
        });
        break;
      default: break;
    }
  }
  /* ---- hair: in front (cap / fringe over the forehead) ---- */
  function hairFront(ctx, spec, hc, lw) {
    var dark = shade(hc, 0.28), light = tint(hc, 0.22);
    var hat = spec.hat !== 'none';
    function capPath(c, sideY, fringeY) {
      /* smooth cap from temple to temple over the crown */
      c.beginPath();
      c.moveTo(29, sideY);
      c.bezierCurveTo(28, 26, 34, 18, 50, 18);
      c.bezierCurveTo(66, 18, 72, 26, 71, sideY);
      c.bezierCurveTo(68, fringeY - 2, 60, fringeY, 50, fringeY);
      c.bezierCurveTo(40, fringeY, 32, fringeY - 2, 29, sideY);
      c.closePath();
    }
    switch (spec.hair) {
      case 'short':
        twoTone(ctx, function (c) {
          c.beginPath();
          c.moveTo(29, 42);
          c.bezierCurveTo(27, 28, 33, 18, 50, 18);
          c.bezierCurveTo(67, 18, 73, 28, 71, 42);
          c.lineTo(69, 38);
          c.bezierCurveTo(70, 30, 62, 29, 56, 29);
          c.bezierCurveTo(48, 28, 40, 32, 34, 30);
          c.bezierCurveTo(31, 33, 31, 36, 31, 40);
          c.closePath();
        }, hc, dark, -3, -2, lw);
        break;
      case 'buzz':
        ctx.save(); ctx.globalAlpha = 0.82;
        twoTone(ctx, function (c) {
          c.beginPath();
          c.moveTo(29.5, 40);
          c.bezierCurveTo(28, 28, 34, 19, 50, 19);
          c.bezierCurveTo(66, 19, 72, 28, 70.5, 40);
          c.lineTo(69, 38);
          c.bezierCurveTo(69, 31, 62, 27, 50, 27);
          c.bezierCurveTo(38, 27, 31, 31, 31, 38);
          c.closePath();
        }, hc, dark, -2, -1, lw * 0.8);
        ctx.restore();
        break;
      case 'curly':
        twoTone(ctx, function (c) {
          c.beginPath();
          var pts = [[33, 31], [41, 27], [50, 26], [59, 27], [67, 31]];
          c.moveTo(29, 36);
          for (var i = 0; i < pts.length; i++) c.arc(pts[i][0], pts[i][1], 6.5, 0, Math.PI * 2);
          c.arc(50, 22, 12, 0, Math.PI * 2);
          c.closePath();
        }, hc, dark, -3, -2, lw);
        break;
      case 'long':
        twoTone(ctx, function (c) {
          c.beginPath();
          c.moveTo(29, 46);
          c.bezierCurveTo(27, 28, 33, 18, 50, 18);
          c.bezierCurveTo(67, 18, 73, 28, 71, 46);
          c.lineTo(70, 40);
          c.bezierCurveTo(69, 32, 62, 30, 58, 33);   /* side-swept fringe, parted right */
          c.bezierCurveTo(52, 37, 44, 38, 38, 33);
          c.bezierCurveTo(33, 30, 31, 36, 30, 40);
          c.closePath();
        }, hc, dark, -3, -2, lw);
        break;
      case 'wavy':
        twoTone(ctx, function (c) {
          c.beginPath();
          c.moveTo(29, 44);
          c.bezierCurveTo(27, 28, 33, 18, 50, 18);
          c.bezierCurveTo(67, 18, 73, 28, 71, 44);
          c.bezierCurveTo(72, 36, 66, 30, 60, 32);
          c.bezierCurveTo(56, 37, 52, 30, 46, 33);
          c.bezierCurveTo(42, 37, 36, 31, 33, 35);
          c.bezierCurveTo(30, 38, 30, 41, 29, 44);
          c.closePath();
        }, hc, dark, -3, -2, lw);
        break;
      case 'ponytail':
      case 'bun':
      case 'braids':
        twoTone(ctx, function (c) { capPath(c, 38, 30); }, hc, dark, -3, -2, lw);
        /* centre part for braids, sheen for pulled-back styles */
        ctx.lineWidth = lw * 0.7; ctx.strokeStyle = spec.hair === 'braids' ? dark : light;
        ctx.beginPath();
        if (spec.hair === 'braids') { ctx.moveTo(50, 19); ctx.lineTo(50, 30); }
        else { ctx.moveTo(38, 22); ctx.quadraticCurveTo(46, 17, 58, 20); }
        ctx.stroke();
        break;
      case 'afro':
        twoTone(ctx, function (c) {
          c.beginPath();
          c.moveTo(29, 40);
          c.bezierCurveTo(27, 26, 33, 16, 50, 16);
          c.bezierCurveTo(67, 16, 73, 26, 71, 40);
          c.bezierCurveTo(70, 32, 62, 28, 50, 28);
          c.bezierCurveTo(38, 28, 30, 32, 29, 40);
          c.closePath();
        }, hc, dark, -3, -2, lw);
        break;
      case 'bald':
        if (!hat) { ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = lw * 0.8; ctx.beginPath(); ctx.moveTo(40, 25); ctx.quadraticCurveTo(46, 20, 54, 21); ctx.stroke(); }
        break;
      default: break;
    }
  }

  function drawEyes(ctx, spec, lw, expr) {
    var kind = spec.eyes, iris = '#2a1b14', up = expr === 'happy' ? 0.6 : 0;
    [41, 59].forEach(function (x, i) {
      var y = 45;
      var rx = kind === 'round' ? 3.4 : 3.9, ry = kind === 'round' ? 3.3 : (kind === 'almond' ? 2.3 : 1.5);
      if (expr === 'happy' && kind !== 'narrow') ry *= 0.85;
      var pathFn = function (c) {
        if (kind === 'almond') {
          c.beginPath(); c.moveTo(x - rx, y + 0.4);
          c.quadraticCurveTo(x, y - ry * 2.1 + 0.4, x + rx, y + 0.4);
          c.quadraticCurveTo(x, y + ry * 1.3, x - rx, y + 0.4); c.closePath();
        } else ellipsePath(c, x, y, rx, ry);
      };
      fillStroke(ctx, pathFn, '#fffaf2', lw * 0.6);
      ctx.save(); pathFn(ctx); ctx.clip();
      var ir = kind === 'narrow' ? 1.6 : (kind === 'round' ? 2.1 : 1.9);
      ellipsePath(ctx, x + (i ? -0.3 : 0.3), y - up * 0.3, ir, ir); ctx.fillStyle = iris; ctx.fill();
      ellipsePath(ctx, x + (i ? -0.9 : -0.3), y - 0.8, 0.6, 0.6); ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.restore();
      /* upper lid line for almond/narrow */
      if (kind !== 'round') { ctx.lineWidth = lw * 0.8; ctx.strokeStyle = OUTLINE; ctx.beginPath(); ctx.moveTo(x - rx, y + 0.4); ctx.quadraticCurveTo(x, y - ry * 2.1 + 0.4, x + rx, y + 0.4); ctx.stroke(); }
    });
  }
  function drawBrows(ctx, spec, hc, lw, expr) {
    var col = shade(hc, 0.35), kind = spec.brows;
    var lift = expr === 'happy' ? -1.6 : 0;
    ctx.lineWidth = lw * (kind === 'straight' ? 1.5 : 1.3); ctx.strokeStyle = col; ctx.lineCap = 'round';
    [[37, 45.5], [54.5, 63]].forEach(function (seg, i) {
      var xo = i ? seg[1] : seg[0], xi = i ? seg[0] : seg[1];   /* outer / inner x */
      var yo = 37.5 + lift, yi = 37.5 + lift, ym = (kind === 'arched' ? 33.6 : (kind === 'soft' ? 35.8 : 37.3)) + lift;
      if (expr === 'worried') { yi -= 2.2; yo += 1.2; ym -= 0.6; }
      ctx.beginPath(); ctx.moveTo(xo, yo);
      ctx.quadraticCurveTo((xo + xi) / 2, ym, xi, yi);
      ctx.stroke();
    });
  }
  function drawNose(ctx, lw) {
    ctx.lineWidth = lw * 0.75; ctx.strokeStyle = 'rgba(59,42,30,0.75)'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(48.5, 47); ctx.quadraticCurveTo(46.3, 54.5, 50.5, 55.2); ctx.stroke();
  }
  function drawMouth(ctx, spec, lw, expr) {
    var kind = spec.mouth;
    if (expr === 'happy') kind = kind === 'neutral' ? 'smile' : 'grin';
    if (expr === 'worried') kind = kind === 'grin' ? 'smile' : 'worried';
    ctx.lineCap = 'round'; ctx.strokeStyle = OUTLINE; ctx.lineWidth = lw * 0.95;
    if (kind === 'smile') {
      ctx.beginPath(); ctx.moveTo(44.5, 59.3); ctx.quadraticCurveTo(50, 65, 55.5, 59.3); ctx.stroke();
      ctx.lineWidth = lw * 0.6; ctx.strokeStyle = 'rgba(59,42,30,0.45)';
      ctx.beginPath(); ctx.moveTo(44.5, 59.3); ctx.lineTo(43.6, 58.2); ctx.moveTo(55.5, 59.3); ctx.lineTo(56.4, 58.2); ctx.stroke();
    } else if (kind === 'neutral') {
      ctx.beginPath(); ctx.moveTo(45.5, 60); ctx.quadraticCurveTo(50, 61.6, 54.5, 60); ctx.stroke();
    } else if (kind === 'worried') {
      ctx.beginPath(); ctx.moveTo(45.5, 61); ctx.quadraticCurveTo(48, 59.2, 50.5, 60.6); ctx.quadraticCurveTo(52.5, 61.8, 54.5, 60.2); ctx.stroke();
    } else { /* grin: open smile with teeth */
      var mouthPath = function (c) { c.beginPath(); c.moveTo(43.2, 58.4); c.quadraticCurveTo(50, 68.5, 56.8, 58.4); c.quadraticCurveTo(50, 60.6, 43.2, 58.4); c.closePath(); };
      fillStroke(ctx, mouthPath, '#5a2a2a', 0);
      ctx.save(); mouthPath(ctx); ctx.clip();
      ctx.fillStyle = '#fffaf2'; ctx.fillRect(42, 56, 16, 3.6);
      ctx.restore();
      fillStroke(ctx, mouthPath, null, lw * 0.9);
    }
  }
  function drawFacialHair(ctx, spec, hc, lw, part) {
    var fh = spec.facialHair; if (fh === 'none') return;
    var col = shade(hc, 0.15), dark = shade(hc, 0.4);
    if (part === 'beard') {
      if (fh === 'stubble') {
        ctx.save(); headPath(ctx); ctx.clip();
        ctx.fillStyle = col; ctx.globalAlpha = 0.28;
        ctx.beginPath(); ctx.moveTo(30, 50); ctx.bezierCurveTo(31, 62, 40, 68, 50, 68); ctx.bezierCurveTo(60, 68, 69, 62, 70, 50);
        ctx.bezierCurveTo(66, 56, 60, 58, 56, 57); ctx.lineTo(44, 57); ctx.bezierCurveTo(40, 58, 34, 56, 30, 50); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 0.5;
        for (var i = 0; i < 26; i++) { var a = (i * 2.399) % 6.283, r = 6 + (i * 0.618 % 1) * 12; var x = 50 + Math.cos(a) * r * 1.5, y = 60 + Math.sin(a) * r * 0.5; if (y > 56 && y < 67.5) { ctx.beginPath(); ctx.arc(x, y, 0.55, 0, 6.283); ctx.fill(); } }
        ctx.restore();
      } else if (fh === 'beard') {
        twoTone(ctx, function (c) {
          c.beginPath();
          c.moveTo(29.5, 46);
          c.bezierCurveTo(29, 60, 36, 74, 50, 75);
          c.bezierCurveTo(64, 74, 71, 60, 70.5, 46);
          c.bezierCurveTo(68, 54, 62, 55, 58, 53.5);   /* cheek line down to the mouth */
          c.bezierCurveTo(56, 56.5, 54, 57.5, 50, 57.5);
          c.bezierCurveTo(46, 57.5, 44, 56.5, 42, 53.5);
          c.bezierCurveTo(38, 55, 32, 54, 29.5, 46);
          c.closePath();
        }, col, dark, -3, -2, lw);
      }
    } else if (part === 'moustache' && (fh === 'moustache' || fh === 'beard')) {
      twoTone(ctx, function (c) {
        c.beginPath();
        c.moveTo(50, 57.2);
        c.bezierCurveTo(53, 55.2, 57, 55.2, 59.5, 57.8);
        c.bezierCurveTo(57.5, 59.6, 53.5, 59.4, 50, 58.6);
        c.bezierCurveTo(46.5, 59.4, 42.5, 59.6, 40.5, 57.8);
        c.bezierCurveTo(43, 55.2, 47, 55.2, 50, 57.2);
        c.closePath();
      }, col, dark, -1.5, -1, lw * 0.8);
    }
  }
  function drawGlasses(ctx, spec, lw) {
    var g = spec.glasses; if (g === 'none') return;
    var frame = g === 'sun' ? '#1b1b22' : '#2c2c30';
    ctx.lineWidth = lw * 1.05; ctx.strokeStyle = frame; ctx.lineCap = 'round';
    var lens = function (c, x) {
      if (g === 'round') ellipsePath(c, x, 45.2, 6.2, 5.8);
      else { c.beginPath(); roundRect(c, x - 6.6, 39.6, 13.2, 10.6, g === 'sun' ? 4 : 2.2); }
    };
    [41, 59].forEach(function (x) {
      lens(ctx, x);
      ctx.fillStyle = g === 'sun' ? 'rgba(24,22,30,0.96)' : 'rgba(255,255,255,0.14)'; ctx.fill();
      ctx.stroke();
      if (g === 'sun') { ctx.save(); lens(ctx, x); ctx.clip(); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = lw * 0.9; ctx.beginPath(); ctx.moveTo(x - 6, 43); ctx.lineTo(x + 2, 40); ctx.stroke(); ctx.restore(); ctx.strokeStyle = frame; ctx.lineWidth = lw * 1.05; }
    });
    ctx.beginPath(); ctx.moveTo(47.3, 44.4); ctx.quadraticCurveTo(50, 42.6, 52.7, 44.4); ctx.stroke();               /* bridge */
    ctx.beginPath(); ctx.moveTo(34.6, 44.2); ctx.lineTo(30.2, 43.2); ctx.moveTo(65.4, 44.2); ctx.lineTo(69.8, 43.2); ctx.stroke(); /* temples */
  }
  function roundRect(c, x, y, w, h, r) {
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  function drawHat(ctx, spec, outfitHex, lw) {
    var hat = spec.hat; if (hat === 'none') return;
    var lift = HAIR_LIFT[spec.hair] || 0;
    ctx.save(); ctx.translate(0, -lift);
    var col, dark;
    if (hat === 'cap' || hat === 'beanie') { col = shade(outfitHex, 0.12); dark = shade(outfitHex, 0.38); }
    else if (hat === 'widebrim') { col = '#c9a66b'; dark = shade(col, 0.32); }
    else if (hat === 'helmet') { col = '#c94a2e'; dark = shade(col, 0.32); }
    else { col = '#f2c02e'; dark = shade(col, 0.3); }
    if (hat === 'cap') {
      twoTone(ctx, function (c) { ellipsePath(c, 54, 29.5, 27, 4.2); }, dark, shade(dark, 0.3), -3, -1, lw);
      twoTone(ctx, function (c) { c.beginPath(); c.moveTo(27.5, 30); c.bezierCurveTo(27, 9, 73, 9, 72.5, 30); c.closePath(); }, col, dark, -4, -3, lw);
      ctx.lineWidth = lw * 0.7; ctx.strokeStyle = dark; ctx.beginPath(); ctx.moveTo(50, 10); ctx.lineTo(50, 29); ctx.stroke();
      fillStroke(ctx, function (c) { ellipsePath(c, 50, 10, 1.8, 1.8); }, col, lw * 0.7);
    } else if (hat === 'widebrim') {
      twoTone(ctx, function (c) { c.beginPath(); c.moveTo(35, 28); c.bezierCurveTo(35, 6, 65, 6, 65, 28); c.closePath(); }, col, dark, -3, -3, lw);
      ctx.lineWidth = lw * 0.8; ctx.strokeStyle = dark; ctx.beginPath(); ctx.moveTo(41, 12); ctx.quadraticCurveTo(50, 18, 59, 12); ctx.stroke();   /* crown dent */
      fillStroke(ctx, function (c) { c.beginPath(); roundRect(c, 35, 23, 30, 4.5, 1); }, shade(col, 0.45), lw * 0.7);                     /* band */
      twoTone(ctx, function (c) { ellipsePath(c, 50, 28.5, 34, 6.2); }, col, dark, -4, -2, lw);
      ctx.save(); ellipsePath(ctx, 50, 28.5, 34, 6.2); ctx.clip(); ctx.fillStyle = 'rgba(59,42,30,0.22)'; ctx.fillRect(33, 28.5, 34, 8); ctx.restore(); /* underside */
    } else if (hat === 'beanie') {
      twoTone(ctx, function (c) { c.beginPath(); c.moveTo(27.5, 34); c.bezierCurveTo(26, 4, 74, 4, 72.5, 34); c.closePath(); }, col, dark, -4, -3, lw);
      ctx.save(); ctx.beginPath(); ctx.moveTo(27.5, 34); ctx.bezierCurveTo(26, 4, 74, 4, 72.5, 34); ctx.closePath(); ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = lw * 0.6; for (var i = -3; i < 4; i++) { ctx.beginPath(); ctx.moveTo(50 + i * 7, 6); ctx.quadraticCurveTo(50 + i * 9, 18, 50 + i * 11, 30); ctx.stroke(); }
      ctx.restore();
      twoTone(ctx, function (c) { c.beginPath(); roundRect(c, 26.5, 25.5, 47, 9, 4); }, tint(col, 0.08), dark, -3, -1, lw);
    } else if (hat === 'helmet') {
      twoTone(ctx, function (c) { ellipsePath(c, 50, 29, 31, 5.4); }, col, dark, -4, -2, lw);
      twoTone(ctx, function (c) { c.beginPath(); c.moveTo(28, 29); c.bezierCurveTo(27, 6, 73, 6, 72, 29); c.closePath(); }, col, dark, -4, -3, lw);
      ctx.lineWidth = lw * 0.8; ctx.strokeStyle = dark; ctx.beginPath(); ctx.moveTo(50, 9); ctx.lineTo(50, 28); ctx.stroke();   /* ridge */
      fillStroke(ctx, function (c) { c.beginPath(); c.moveTo(45.5, 15); c.lineTo(54.5, 15); c.lineTo(54.5, 21); c.quadraticCurveTo(50, 25, 45.5, 21); c.closePath(); }, '#f2c02e', lw * 0.7); /* shield */
    } else if (hat === 'hardhat') {
      twoTone(ctx, function (c) { c.beginPath(); c.moveTo(29, 30); c.bezierCurveTo(28, 7, 72, 7, 71, 30); c.closePath(); }, col, dark, -4, -3, lw);
      ctx.lineWidth = lw * 0.8; ctx.strokeStyle = dark; ctx.beginPath(); ctx.moveTo(43, 11); ctx.lineTo(41, 28); ctx.moveTo(57, 11); ctx.lineTo(59, 28); ctx.stroke(); /* ribs */
      twoTone(ctx, function (c) { ellipsePath(c, 50, 30, 28, 4.6); }, col, dark, -4, -2, lw);
    }
    ctx.restore();
  }
  function drawAccessory(ctx, spec, lw) {
    var a = spec.accessory; if (a === 'none') return;
    if (a === 'clipboard') {
      ctx.save(); ctx.translate(20, 88); ctx.rotate(-0.22);
      twoTone(ctx, function (c) { c.beginPath(); roundRect(c, -10, -13, 20, 27, 1.6); }, '#8a6a3a', shade('#8a6a3a', 0.35), -1.5, -1, lw);
      fillStroke(ctx, function (c) { c.beginPath(); c.rect(-8.2, -9.5, 16.4, 22); }, '#fbf6ea', lw * 0.6);
      fillStroke(ctx, function (c) { c.beginPath(); roundRect(c, -4, -14.5, 8, 4, 1); }, '#5a5a60', lw * 0.6);
      ctx.strokeStyle = 'rgba(59,42,30,0.5)'; ctx.lineWidth = lw * 0.6; ctx.beginPath();
      for (var i = 0; i < 4; i++) { ctx.moveTo(-6, -5 + i * 4); ctx.lineTo(i === 3 ? 1 : 6, -5 + i * 4); }
      ctx.stroke(); ctx.restore();
    } else if (a === 'binoculars') {
      ctx.lineWidth = lw * 0.8; ctx.strokeStyle = '#2b2b2b'; ctx.beginPath(); ctx.moveTo(43, 74); ctx.quadraticCurveTo(41, 80, 44.5, 86); ctx.moveTo(57, 74); ctx.quadraticCurveTo(59, 80, 55.5, 86); ctx.stroke();
      [45, 55].forEach(function (x) {
        twoTone(ctx, function (c) { c.beginPath(); roundRect(c, x - 4.2, 84, 8.4, 11, 2.4); }, '#3a3a40', '#1c1c22', -1.5, -1, lw * 0.9);
        fillStroke(ctx, function (c) { ellipsePath(c, x, 85.5, 3, 1.4); }, '#7cc4d8', lw * 0.6);
      });
      fillStroke(ctx, function (c) { c.beginPath(); c.rect(48, 88, 4, 4); }, '#2b2b2b', 0);
    } else if (a === 'radio') {
      ctx.lineWidth = lw * 0.9; ctx.strokeStyle = '#2b2b2b'; ctx.beginPath(); ctx.moveTo(23, 78); ctx.lineTo(24.5, 64); ctx.stroke();
      twoTone(ctx, function (c) { c.beginPath(); roundRect(c, 18, 77, 10, 15, 1.8); }, '#3a3a40', '#1c1c22', -1.5, -1, lw * 0.9);
      fillStroke(ctx, function (c) { c.beginPath(); c.rect(20, 79, 6, 4); }, '#7cc4d8', 0);
      fillStroke(ctx, function (c) { ellipsePath(c, 21.5, 86.5, 1.3, 1.3); }, '#f2c02e', 0);
      fillStroke(ctx, function (c) { ellipsePath(c, 25, 86.5, 1.3, 1.3); }, '#e63946', 0);
    } else if (a === 'scarf') {
      var col = '#3ec1b7', dark = shade(col, 0.35);
      twoTone(ctx, function (c) { c.beginPath(); c.moveTo(56, 76); c.bezierCurveTo(60, 84, 62, 90, 60, 97); c.lineTo(52, 97); c.bezierCurveTo(52, 90, 51, 84, 50, 80); c.closePath(); }, col, dark, -2, -1, lw);
      twoTone(ctx, function (c) {
        c.beginPath(); c.moveTo(38, 70); c.bezierCurveTo(36, 78, 44, 84, 50, 84); c.bezierCurveTo(56, 84, 64, 78, 62, 70);
        c.bezierCurveTo(60, 74, 56, 76, 50, 76); c.bezierCurveTo(44, 76, 40, 74, 38, 70); c.closePath();
      }, col, dark, -2, -2, lw);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = lw * 0.6; ctx.beginPath(); ctx.moveTo(41, 76); ctx.quadraticCurveTo(50, 81, 59, 76); ctx.stroke();
    }
  }

  /**
   * Render a portrait into `canvas` (uses canvas.width/height; square recommended).
   * opts: { bg: hex|null (default null = transparent), expression: 'neutral'|'worried'|'happy' }
   */
  function draw(canvas, spec, opts) {
    if (!canvas) return canvas;
    opts = opts || {};
    spec = normalize(spec);
    var ctx = canvas.getContext('2d'); if (!ctx) return canvas;
    var W = canvas.width || 96, Hh = canvas.height || W, size = Math.min(W, Hh);
    var expr = opts.expression === 'worried' || opts.expression === 'happy' ? opts.expression : 'neutral';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, Hh);
    if (opts.bg) { ctx.fillStyle = opts.bg; ctx.fillRect(0, 0, W, Hh); }
    ctx.setTransform(size / 100, 0, 0, size / 100, (W - size) / 2, (Hh - size) / 2);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    var lw = Math.max(1.2, Math.min(3, size / 48)) * 100 / size;   /* ≈ 2 px at 96 px */
    CUR_BODY = spec.body === 'male' ? 'male' : 'female';
    var skin = hexOf('skin', spec.skin), hc = hexOf('hairColor', spec.hairColor), outfit = hexOf('outfit', spec.outfit);
    var skinDark = shade(skin, 0.18);

    /* 1. body + collar */
    twoTone(ctx, bodyPath, outfit, shade(outfit, 0.3), -5, -3, lw);
    ctx.lineWidth = lw * 0.8; ctx.strokeStyle = shade(outfit, 0.45);
    ctx.beginPath(); ctx.moveTo(40, 73.5); ctx.lineTo(50, 84); ctx.lineTo(60, 73.5); ctx.stroke();
    /* 2. hair behind the head (drapes over the shoulders) */
    hairBack(ctx, spec, hc, lw);
    /* 3. neck (shadow under the chin) */
    var nw = CUR_BODY === 'male' ? 17 : 12;
    twoTone(ctx, function (c) { c.beginPath(); roundRect(c, 50 - nw / 2, 58, nw, 20, 3); }, skinDark, shade(skin, 0.36), 0, 5, lw);
    /* 4. ears */
    [29.5, 70.5].forEach(function (x) {
      twoTone(ctx, function (c) { ellipsePath(c, x, 46.5, 4.2, 5.6); }, skin, skinDark, x < 50 ? 1.5 : -2.5, -1.5, lw);
      ctx.lineWidth = lw * 0.6; ctx.strokeStyle = 'rgba(59,42,30,0.55)'; ctx.beginPath(); ctx.moveTo(x + (x < 50 ? 0.8 : -0.8), 44); ctx.quadraticCurveTo(x + (x < 50 ? -1.2 : 1.2), 47, x + (x < 50 ? 0.8 : -0.8), 49.5); ctx.stroke();
    });
    /* 5. head */
    twoTone(ctx, headPath, skin, skinDark, -4, -3, lw);
    /* cheek blush */
    ctx.save(); headPath(ctx); ctx.clip(); ctx.fillStyle = 'rgba(220,100,90,0.13)';
    ellipsePath(ctx, 36, 53, 5, 3); ctx.fill(); ellipsePath(ctx, 64, 53, 5, 3); ctx.fill(); ctx.restore();
    /* 6. features (beard under the mouth, moustache over it) */
    drawFacialHair(ctx, spec, hc, lw, 'beard');
    drawEyes(ctx, spec, lw, expr);
    if (CUR_BODY === 'female') {   /* eyelashes at the outer corners */
      ctx.lineWidth = lw * 0.75; ctx.strokeStyle = OUTLINE;
      [41, 59].forEach(function (x) { var d = x < 50 ? -1 : 1, ox = x + d * 3.7; ctx.beginPath(); ctx.moveTo(ox, 44.6); ctx.lineTo(ox + d * 1.5, 42.8); ctx.moveTo(ox - d * 1.2, 43.2); ctx.lineTo(ox - d * 0.4, 41.6); ctx.stroke(); });
    }
    drawBrows(ctx, spec, hc, lw, expr);
    drawNose(ctx, lw);
    drawMouth(ctx, spec, lw, expr);
    drawFacialHair(ctx, spec, hc, lw, 'moustache');
    drawGlasses(ctx, spec, lw);
    /* 7. hair in front, then the hat over it, then whatever is held or worn */
    hairFront(ctx, spec, hc, lw);
    drawHat(ctx, spec, outfit, lw);
    drawAccessory(ctx, spec, lw);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  /* ------------------------------------------------------------------ cached data URLs */
  var cache = {}, cacheKeys = [], CACHE_MAX = 240, scratch = null;
  function dataURL(spec, size, opts) {
    size = Math.max(8, Math.round(Number(size) || 96));
    var n = normalize(spec);
    var key = JSON.stringify(n) + '|' + size + '|' + JSON.stringify(opts || {});
    if (cache[key]) return cache[key];
    if (typeof document === 'undefined') return '';
    if (!scratch) scratch = document.createElement('canvas');
    scratch.width = size; scratch.height = size;
    draw(scratch, n, opts);
    var url = scratch.toDataURL('image/png');
    cache[key] = url; cacheKeys.push(key);
    if (cacheKeys.length > CACHE_MAX) { var old = cacheKeys.shift(); delete cache[old]; }
    return url;
  }

  WS.Faces = { OPTIONS: OPTIONS, KEYS: KEYS, DEFAULT: DEFAULT, PRESETS: PRESETS, LABELS: LABELS, draw: draw, dataURL: dataURL, random: random, normalize: normalize, hexOf: hexOf, _cacheSize: function () { return cacheKeys.length; } };
})();
