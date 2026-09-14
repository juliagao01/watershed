/* Watershed — Icons: a hand-drawn set of filled silhouette glyphs on a 24-unit grid (no strokes, no gradients, one <path> each).
   Exports WS.Icons = { NAMES, has(name), svg(name, size, cls) → string, el(name, size, cls) → SVGElement, forEmoji(emoji) → name|null, resolve(x) → name }.
   Loads before hud.js; safe in Node (no DOM use until el() is called). Every emoji the sim data / UI ever used maps to a name via EMOJI. */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : globalThis;
  var WS = root.WS = root.WS || {};

  /* d = path data; eo = evenodd (used where a subpath cuts a hole). Silhouettes only. */
  var ICONS = {
    dot: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
    drop: 'M12 2C9 7 6 10.5 6 14.5a6 6 0 0 0 12 0C18 10.5 15 7 12 2z',
    fire: 'M13.5 2C14 6 18 8 18 13.5a6 6 0 0 1-12 0c0-2.3 1-4.2 2.4-5.5.1 1.8.8 3 2.1 3.7C9.3 8.6 10.3 4.5 13.5 2z',
    'flame-small': 'M12.8 6C13.2 8.8 16 10.2 16 14a4 4 0 0 1-8 0c0-1.6.7-2.9 1.6-3.8.1 1.2.6 2 1.4 2.5-.8-2-.1-4.8 1.8-6.7z',
    tree: 'M12 2 17 9h-2.2l3.7 6H14v5h-4v-5H5.5l3.7-6H7z',
    trees: 'M8 5 4 11h1.6L3 16h4v3h2v-3h1.4L8.6 11H10z M16 3l-4.5 7h2L11 16h4v4h2v-4h4l-2.5-6h2z',
    house: 'M12 3 2 12h3v8h5v-5h4v5h5v-8h3z',
    houses: 'M8 7 2 13h2v6h3v-4h2v4h3v-6h2z M16 3l-5 6h1.5v10h2.5v-4h2v4h2.5V9H21z',
    building: { eo: true, d: 'M12 2 1.5 8H3v11H2v3h20v-3h-1V8h1.5z M5.5 10h4v9h-4z M14.5 10h4v9h-4z' },
    siren: 'M11 3h2v3.4A5 5 0 0 1 17 12v5H7v-5a5 5 0 0 1 4-4.6z M4 18h16v3H4z',
    gauge: 'M2 16A10 10 0 0 1 22 16v1h-4v-1a6 6 0 0 0-12 0v1H2z M11.2 16.8 16.5 9l1.4 1-4.2 8.2z M10 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0z',
    snowflake: 'M11 2h2v20h-2z M20.16 6.13 21.16 7.87 3.84 17.87 2.84 16.13z M3.84 6.13 2.84 7.87 20.16 17.87 21.16 16.13z',
    dam: 'M2 21V4h7v17z M9 21v-4c2-1 4-1 6 0s4 1 7 0v4z M10 13.5c2-1 4-1 6 0s4 1 6 0v2c-2 1-4 1-6 0s-4-1-6 0z',
    stream: 'M8 2C5 5 5 7 8 9c3 2 3 4 0 6s-3 4 0 7h3c-3-3-3-5 0-7s3-4 0-6-3-4 0-7z',
    wave: 'M2 6c3-3 5-3 7 0s4 3 6 0 4-3 7 0v3c-3-3-5-3-7 0s-4 3-6 0-4-3-7 0z M2 14c3-3 5-3 7 0s4 3 6 0 4-3 7 0v3c-3-3-5-3-7 0s-4 3-6 0-4-3-7 0z',
    drought: 'M2 13h9l-2 3 2 3-1.5 3H2z M13.5 13H22v9h-9l1.5-3-2-3z M12 2.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z',
    thermometer: 'M9.5 4a2.5 2.5 0 0 1 5 0v9.5a4.5 4.5 0 1 1-5 0z',
    soil: 'M11 15C7 15 4 12 4 8c4 0 7 3 7 7z M13 13c0-5 3-8 8-8 0 5-3 8-8 8z M11 22V13h2v9z',
    person: 'M8.5 5a3.5 3.5 0 0 1 3.03 5.25C14.5 12 15.5 15 15.5 18v3h-14v-3c0-3 1-6 3.97-7.75A3.5 3.5 0 0 1 8.5 5z',
    people: 'M17 5a3 3 0 0 1 2.6 4.5C22 11 23 14 23 17v3H11v-3c0-3 1-6 3.4-7.5A3 3 0 0 1 17 5z M8 5a3.5 3.5 0 0 1 3.03 5.25C14 12 15 15 15 18v3H1v-3c0-3 1-6 3.97-7.75A3.5 3.5 0 0 1 8 5z',
    wind: 'M2 7h13.5v2.5H2z M15.5 7A3.5 3.5 0 1 1 19 3.5h-2.3a1.2 1.2 0 1 0-1.2 1.2z M2 12h9.5a1.5 1.5 0 0 1 0 3H2z',
    'cloud-rain': 'M7 12a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17.2 5.5 3.5 3.5 0 0 1 17 12z M8.5 14l-2 5h2.2l2-5z M13.5 14l-2 5h2.2l2-5z',
    storm: 'M7 11a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17.2 4.5 3.5 3.5 0 0 1 17 11z M13 12l-5 6h3.5L10 23l6-7h-3.5z',
    cloud: 'M7 18a4.5 4.5 0 0 1-.6-8.95A6 6 0 0 1 18 10.5a3.75 3.75 0 0 1 0 7.5z',
    sun: 'M12.0 2.0L14.8 5.3L19.1 4.9L18.7 9.2L22.0 12.0L18.7 14.8L19.1 19.1L14.8 18.7L12.0 22.0L9.2 18.7L4.9 19.1L5.3 14.8L2.0 12.0L5.3 9.2L4.9 4.9L9.2 5.3z',
    coins: 'M12 3c5 0 9 1.5 9 3.5S17 10 12 10 3 8.5 3 6.5 7 3 12 3z M3 9c0 2 4 3.5 9 3.5s9-1.5 9-3.5v3c0 2-4 3.5-9 3.5S3 14 3 12z M3 14.5c0 2 4 3.5 9 3.5s9-1.5 9-3.5v3c0 2-4 3.5-9 3.5S3 19.5 3 17.5z',
    check: 'M9.5 17.5 4 12l1.8-1.8 3.7 3.7 8.7-8.7L20 7z',
    cross: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4L12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z',
    plus: 'M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z',
    minus: 'M3 10h18v4H3z',
    lock: { eo: true, d: 'M7 10V7a5 5 0 0 1 10 0v3h2v11H5V10z M9 10h6V7a3 3 0 0 0-6 0z' },
    'arrow-up': 'M12 3l7 7h-4v11H9V10H5z',
    'arrow-down': 'M12 21l7-7h-4V3H9v11H5z',
    alert: { eo: true, d: 'M12 2 1 21h22z M11 9h2v6h-2z M11 16.5h2v2h-2z' },
    info: { eo: true, d: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M11 10h2v7h-2z M11 6.5h2v2h-2z' },
    question: { eo: true, d: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M8.5 9.5a3.5 3.5 0 1 1 5.2 3c-.6.4-.7.7-.7 1.5v.5h-2v-.7c0-1.4.4-2.1 1.4-2.8a1.5 1.5 0 1 0-1.9-1.5z M11 16h2v2h-2z' },
    pause: 'M6 4h4v16H6z M14 4h4v16h-4z',
    play: 'M7 4l13 8-13 8z',
    speed: 'M3 5l9 7-9 7z M12 5l9 7-9 7z',
    clock: { eo: true, d: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M11 7h2v5.5l3.5 2-1 1.7L11 13.5z' },
    dozer: 'M4 15V9h3V5h6v4h3l2.5 6z M3 16h15a2.5 2.5 0 0 1 0 5H3a2.5 2.5 0 0 1 0-5z M20 10h2v10h-2z',
    tanker: 'M12 2c1 0 1.5 2 1.5 4v3l8 5v2l-8-2.5v4l2.5 1.8V21L12 19.8 8 21v-1.7l2.5-1.8v-4L2.5 16v-2l8-5V6c0-2 .5-4 1.5-4z',
    engine: 'M2 8h1V6h3v2h8l1 3h3l3 3v4H2z M4 18a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0z M15 18a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0z',
    megaphone: 'M3 10v4h3l8 5V5L6 10z M16 8.5a4 4 0 0 1 0 7v-2a2 2 0 0 0 0-3z M5 14h3l1.5 6H7z',
    phone: 'M6.6 3c.5 0 .9.3 1 .7l1.4 4a1 1 0 0 1-.3 1L7 10.5c1.5 3 3.5 5 6.5 6.5l1.8-1.7a1 1 0 0 1 1-.2l4 1.4c.4.1.7.5.7 1V21c0 .6-.4 1-1 1C10.5 22 2 13.5 2 4c0-.6.4-1 1-1z',
    sandbag: 'M3 20c0-3 2-5 5-5s5 2 5 5z M11 20c0-3 2-5 5-5s5 2 5 5z M7 14c0-3 2-5 5-5s5 2 5 5z',
    pump: 'M3 11h13a3 3 0 0 1 3 3v6H3z M8 5h6v6H8z M19 15h3v2h-3z',
    wetland: 'M10 4a2 2 0 0 1 4 0v7a2 2 0 0 1-4 0z M11.2 11h1.6v11h-1.6z M3 8c4 1 7 5 8 13C6 19 3 14 3 8z',
    leaf: { eo: true, d: 'M3 21C3 11 9 4 21 3c-1 12-8 18-18 18z M5 19c3-6 7-10 12-13-6 2-10 6-13 12z' },
    beaver: 'M9 7c4-2 9-1 11 3 1.5 3 0 6-3 7H8c-3 0-5-2-5-4.5S5 8.5 9 7z M3 14h4l1 6c0 1-1 2-2.5 2S3 21 3 20z M17.5 5.5a1.6 1.6 0 1 1-.01 0z',
    pivot: 'M2 5h20v3h-5v3h-2V8H9v3H7V8H2z M8 14l-2.5 5h5z M16 14l-2.5 5h5z',
    plant: 'M3 21V10l5 3.5V10l5 3.5V10l5 3.5V6h3v15z M5 3h3v9H5z',
    shelter: { eo: true, d: 'M3 21V9l9-6 9 6v12z M11 11h2v3h3v2h-3v3h-2v-3H8v-2h3z' },
    mussel: { eo: true, d: 'M12 4c-5.5 0-9 4.5-9 9.5L12 21l9-7.5C21 8.5 17.5 4 12 4z M11.3 7h1.4v11h-1.4z' },
    barrel: { eo: true, d: 'M6 3h12l1 3v12l-1 3H6l-1-3V6z M5 9h14v1.5H5z M5 13.5h14V15H5z' },
    bales: 'M3 17a4 4 0 1 1 8 0 4 4 0 0 1-8 0z M13 17a4 4 0 1 1 8 0 4 4 0 0 1-8 0z M8 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0z',
    elk: 'M12 10a3.5 3.5 0 0 1 3.5 3.5V19a3.5 3.5 0 0 1-7 0v-5.5A3.5 3.5 0 0 1 12 10z M9.4 11.5 6.2 3.2l1.7-.7 1.6 4.2 1.4-3.4 1.6.7-2.3 5.6z M14.6 11.5l3.2-8.3-1.7-.7-1.6 4.2-1.4-3.4-1.6.7 2.3 5.6z',
    banner: 'M3 4h18v10H3z M11 14h2v8h-2z',
    flag: 'M4 2h2v20H4z M6 3h13l-2.5 4.5L19 12H6z',
    gage: 'M3 21v-9l6-5 6 5v9z M16 3h2v4h1.5v1H18v3h1.5v1H18v9h-2v-9h-1.5v-1H16V8h-1.5V7H16z',
    leak: 'M2 7h8.5v5H2z M13.5 7H22v5h-8.5z M12 13c-1.6 2.2-2.5 3.6-2.5 5a2.5 2.5 0 0 0 5 0c0-1.4-.9-2.8-2.5-5z',
    book: 'M6 2h14v16H7.5A1.5 1.5 0 0 0 7.5 21H20v1H7.5A2.5 2.5 0 0 1 5 19.5V3a1 1 0 0 1 1-1z',
    notebook: { eo: true, d: 'M5 2h13a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5v-3H3v-2h2v-2H3v-2h2v-2H3V9h2V7H3V5h2z M9 8h8v1.5H9z M9 12h8v1.5H9z' },
    advisors: 'M8 4a3.5 3.5 0 0 1 3.03 5.25C14 11 15 14 15 17v1H1v-1c0-3 1-6 3.97-7.75A3.5 3.5 0 0 1 8 4z M14 3h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-3l-2.5 2.5V10H14a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
    compass: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z M15.5 8.5 13.6 13.6 8.5 15.5l1.9-5.1z',
    volume: 'M3 9v6h4l5 4V5L7 9z M15 8.5a4.5 4.5 0 0 1 0 7v-2a2.5 2.5 0 0 0 0-3z M17.5 5.5a8 8 0 0 1 0 13v-2a6 6 0 0 0 0-9z',
    'volume-muted': 'M3 9v6h4l5 4V5L7 9z M15.5 9.1l1.4-1.4L19 9.8l2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1z',
    'sound-wave': 'M6 8h3v8H6z M10.5 4h3v16h-3z M15 8h3v8h-3z',
    bars: 'M3 12h4v9H3z M10 4h4v17h-4z M17 8h4v13h-4z',
    radio: { eo: true, d: 'M8 2h2v5H8z M6 7h10a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z M8 10h6v3H8z' },
    clipboard: { eo: true, d: 'M7 4h3a2 2 0 0 1 4 0h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M8 9h8v1.5H8z M8 13h8v1.5H8z' },
    binoculars: 'M2 12l2.5-6H8l1 4h6l1-4h3.5L22 12v9h-8v-6h-4v6H2z M10 5h4v2h-4z',
    hat: 'M7 10c0-4 2-7 5-7s5 3 5 7v2H7z M2 13c3 2 7 3 10 3s7-1 10-3v2c-3 2-7 3-10 3S5 17 2 15z',
    scarf: 'M6 4h12l-2 5H8z M9 9h6v3l-2 9h-3l1-9H9z',
    star: 'M12.0 2.1L14.6 9.0L22.0 9.4L16.2 14.0L18.2 21.1L12.0 17.0L5.8 21.1L7.8 14.0L2.0 9.4L9.4 9.0z',
    pin: 'M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7z M12 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    calendar: { eo: true, d: 'M5 4h2V2h2v2h6V2h2v2h2a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M6 9v10h12V9z M8 11h8v3H8z' },
    dice: { eo: true, d: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M7 7a2 2 0 1 0 4 0 2 2 0 0 0-4 0z M13 15a2 2 0 1 0 4 0 2 2 0 0 0-4 0z' },
    crew: 'M4 14a8 8 0 0 1 16 0v1H4z M2 15h20v3H2z M10 4h4v6h-4z',
    map: { eo: true, d: 'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2z M8.5 3.2h1v15.6h-1z M14.5 5.2h1v15.6h-1z' },
    target: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z',
    chevron: 'M12 16.5 4.5 9l1.8-1.8L12 12.9l5.7-5.7L19.5 9z',
    'chevron-down': 'M12 16.5 4.5 9l1.8-1.8L12 12.9l5.7-5.7L19.5 9z',
    'chevron-up': 'M12 7.5l7.5 7.5-1.8 1.8L12 11.1l-5.7 5.7L4.5 15z',
    'chevron-left': 'M15 4.5 7.5 12l7.5 7.5 1.8-1.8L11.1 12l5.7-5.7z',
    'chevron-right': 'M9 4.5 16.5 12 9 19.5l-1.8-1.8L12.9 12 7.2 6.3z',
    scales: 'M11 3h2v3h7v1.5h-7V19h5v2H6v-2h5V7.5H4V6h7z M2 13l3.5-6L9 13c0 2-1.5 3-3.5 3S2 15 2 13z M15 13l3.5-6L22 13c0 2-1.5 3-3.5 3S15 15 15 13z',
    extinguisher: 'M9 6h6a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a2 2 0 0 1 2-2z M10 2h4v3h-4z M7 6H5a2 2 0 0 0-2 2v2h1.5V8.5A.5.5 0 0 1 5 8h2z',
    fish: { eo: true, d: 'M3 12c2.5-4 6-6 10-6 3 0 5.5 2 7.5 5L23 8v8l-2.5-3C18.5 16 16 18 13 18c-4 0-7.5-2-10-6z M15 11a1.3 1.3 0 1 1 2.6 0 1.3 1.3 0 0 1-2.6 0z' },
    mountain: 'M2 20 9 8l3.5 5.5L15 10l7 10z',
    flask: 'M9 2h6v2h-1v5l5.5 9.5A2 2 0 0 1 17.8 22H6.2a2 2 0 0 1-1.7-3.5L10 9V4H9z',
    axe: 'M5 21l-1.5-1.5L14 9l1.5 1.5z M12.5 5c1.5-1.5 4-2 6.5-1 1 2.5.5 5-1 6.5L12.5 5z',
    hands: 'M1 7h6l5 3 5-3h6v8h-4l-4 4h-2l-1-1-1 1H9l-4-4H1z M9.5 11.5h5v1.5h-5z',
    bolt: 'M13 2 4 14h6l-1 8 9-12h-6z',
    feather: { eo: true, d: 'M20 3c-6 0-11 4-13 10l-4 8 2 1 4-8c6 0 10-4 11-11z M8.5 15.5l6-6 .7.7-6 6z' },
    boat: 'M3 14h18l-2 5H5z M8 8h8l2 6H6z M11 4h2v4h-2z',
    sailboat: 'M12 2v12h9z M4 14h7V4z M2 16h20l-3 4H5z',
    rock: 'M4 18l3-8 5-4 6 3 3 6-2 4H5z',
    log: { eo: true, d: 'M5 8h13a4 4 0 0 1 0 8H5a4 4 0 0 1 0-8z M5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z' },
    basin: 'M1 7h22v2h-2l-2.5 12h-13L3 9H1z',
    buoy: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
    chart: 'M3 17l5-5 4 3 6-7 2 2v-6h-6l2 2-4.5 5.5-4-3L2 15.5z M3 19h18v2H3z',
    'chart-down': 'M3 7l5 5 4-3 6 7 2-2v6h-6l2-2-4.5-5.5-4 3L2 8.5z M3 19h18v2H3z',
    grad: 'M12 3 1 8l11 5 9-4.1V15h2V8z M5 11.5v4c0 2 3 3.5 7 3.5s7-1.5 7-3.5v-4l-7 3.2z',
    keyboard: { eo: true, d: 'M2 6h20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z M5 9h14v2H5z M7 14h10v2H7z' },
    idcard: { eo: true, d: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M8 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4z M13 9h6v1.5h-6z' },
    bug: 'M9 4a3 3 0 0 1 6 0v4H9z M6 9h12l3-2 .7 1.5L19 10.5v3.5l2.7 1.8-.9 1.6L18.5 16A6.5 6.5 0 0 1 12 21a6.5 6.5 0 0 1-6.5-5L3.2 17.4l-.9-1.6L5 14v-3.5L2.3 8.5 3 7z',
    bucket: 'M4 6h16l-2 15H6z M8 6a4 4 0 0 1 8 0h-2a2 2 0 0 0-4 0z',
    refresh: 'M12 4a8 8 0 1 1-7.3 4.7l1.9.6A6 6 0 1 0 12 6v3L7.5 5.5 12 2z',
    'tap-off': 'M4 8h9V5h2v3h3a3 3 0 0 1 3 3v2h-2v-2a1 1 0 0 0-1-1H4z M6 11h5v5H6z M4 3l17 17-1.4 1.4L2.6 4.4z',
    tools: 'M21.7 6.3 18 10l-3-3 3.7-3.7A6 6 0 0 0 11 9.5l-8.3 8.3 3.5 3.5L14.5 13a6 6 0 0 0 7.2-6.7z'
  };
  var NAMES = Object.keys(ICONS);

  /* Every emoji that appears in the sim data (projects/fire/flood/events/advisors) or ever appeared in the UI. Variation selectors are stripped before lookup. */
  var EMOJI = {
    '💧': 'drop', '🔥': 'fire', '🌲': 'trees', '🌳': 'tree', '🏠': 'house', '🏡': 'house', '🏘': 'houses', '🏙': 'houses', '🏛': 'building', '🏫': 'shelter', '🏥': 'shelter',
    '🚨': 'siren', '📡': 'gauge', '❄': 'snowflake', '🏗': 'dam', '🏔': 'mountain', '🏞': 'stream', '🌊': 'wave', '☀': 'sun', '🌤': 'sun', '🌡': 'thermometer', '🌱': 'soil',
    '👥': 'people', '🧑': 'person', '🌬': 'wind', '🌧': 'cloud-rain', '⛈': 'storm', '🌫': 'cloud', '💵': 'coins', '💰': 'coins', '✔': 'check', '✅': 'check', '✖': 'cross', '❌': 'cross',
    '🔒': 'lock', '⬆': 'arrow-up', '⬇': 'arrow-down', '⚠': 'alert', '‼': 'alert', 'ℹ': 'info', '❔': 'question', '❓': 'question', '⏸': 'pause', '▶': 'play', '⏩': 'speed', '⏱': 'clock', '⏳': 'clock',
    '🚜': 'dozer', '✈': 'tanker', '🚒': 'engine', '📢': 'megaphone', '📣': 'banner', '📞': 'phone', '🧱': 'sandbag', '🔧': 'pump', '🌿': 'wetland', '🦫': 'beaver', '🚿': 'pivot',
    '🏭': 'plant', '🐚': 'mussel', '🛢': 'barrel', '🌾': 'bales', '📦': 'bales', '🦌': 'elk', '🔎': 'leak', '🚰': 'leak', '📚': 'book', '📓': 'notebook', '📖': 'book', '🗣': 'advisors',
    '🧭': 'compass', '🔊': 'volume', '🔇': 'volume-muted', '📻': 'radio', '📋': 'clipboard', '🎲': 'dice', '👷': 'crew', '🗺': 'map', '🎯': 'target', '⚖': 'scales', '🧯': 'extinguisher',
    '🐟': 'fish', '🧪': 'flask', '🟢': 'flask', '🪓': 'axe', '🤝': 'hands', '⚡': 'bolt', '🪶': 'feather', '🛶': 'boat', '🛥': 'boat', '⛵': 'sailboat', '🪨': 'rock', '🟤': 'wind', '🪵': 'log',
    '⭕': 'basin', '🛟': 'buoy', '📈': 'chart', '📉': 'chart-down', '📊': 'bars', '🎓': 'grad', '🏁': 'flag', '⚑': 'flag', '🪧': 'banner', '📅': 'calendar', '🗓': 'calendar', '📍': 'pin',
    '⌨': 'keyboard', '🪪': 'idcard', '🪲': 'bug', '🪣': 'bucket', '⛷': 'mountain', '🤠': 'hat', '🧣': 'scarf', '🔭': 'binoculars', '⭐': 'star', '★': 'star', '🛠': 'tools', '🍂': 'leaf',
    '🌵': 'drought', '💾': 'clipboard', '📂': 'book', '🚱': 'tap-off', '↻': 'refresh', '🔁': 'refresh', '▪': 'dot', '◀': 'chevron-left', '👍': 'check', '👎': 'cross'
  };
  function stripEmoji(s) { return String(s == null ? '' : s).replace(/[︎️‍]|[\u{1F3FB}-\u{1F3FF}]/gu, '').trim(); }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function spec(name) { var ic = ICONS[name]; if (!ic) return null; return typeof ic === 'string' ? { d: ic, eo: false } : { d: ic.d, eo: !!ic.eo }; }

  var Icons = WS.Icons = {
    NAMES: NAMES,
    has: function (name) { return Object.prototype.hasOwnProperty.call(ICONS, String(name)); },
    /** name for an emoji (variation selectors / skin tones ignored; the first code point is tried as a fallback), or null */
    forEmoji: function (emoji) {
      var s = stripEmoji(emoji); if (!s) return null;
      if (EMOJI[s]) return EMOJI[s];
      var first = String.fromCodePoint(s.codePointAt(0));
      return EMOJI[first] || null;
    },
    /** icon name for a name-or-emoji, falling back to `fallback` (default 'dot') */
    resolve: function (x, fallback) {
      if (x == null || x === '') return fallback || 'dot';
      var s = String(x);
      if (Icons.has(s)) return s;
      return Icons.forEmoji(s) || fallback || 'dot';
    },
    /** inline SVG markup */
    svg: function (name, size, cls) {
      var sp = spec(Icons.resolve(name)) || spec('dot'); size = Number(size) || 16;
      return '<svg class="ic-svg' + (cls ? ' ' + esc(cls) : '') + '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path' + (sp.eo ? ' fill-rule="evenodd"' : '') + ' d="' + sp.d + '"/></svg>';
    },
    /** SVGElement (DOM) */
    el: function (name, size, cls) {
      var sp = spec(Icons.resolve(name)) || spec('dot'); size = Number(size) || 16;
      var NS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'ic-svg' + (cls ? ' ' + cls : ''));
      svg.setAttribute('width', size); svg.setAttribute('height', size);
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
      var p = document.createElementNS(NS, 'path');
      if (sp.eo) p.setAttribute('fill-rule', 'evenodd');
      p.setAttribute('d', sp.d);
      svg.appendChild(p);
      return svg;
    },
    EMOJI: EMOJI
  };
})();
