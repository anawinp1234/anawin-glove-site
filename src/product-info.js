// Approved PDP copy for the Size & Fit, Description, and Details accordions.
// Sizes, positions, throw hands, and colorways must agree with catalog.js; tests check them.
const regularFit = ['Wrist fit', 'Regular fit (7–7.5 inches)'];
const trainerFit = Object.freeze({
  rows: [['Size', '10.25 inches'], regularFit, ['Type', 'Defensive training glove'], ['Throwing hand', 'Right-hand throw'], ['Worn on', 'Left hand']]
});
const trainerDetails = colorway => ['U.S. steerhide leather', 'Double finger pad', 'Sheepskin thumb sleeve', '10.25-inch training design', `${colorway} colorway`];
const fullSizeFit = (size, position, bothHands) => ({
  rows: [['Size', `${size} inches`], regularFit, ['Position', position], ...(bothHands
    ? [['Throwing hand', 'Right-hand or left-hand throw'], ['Right-hand throw', 'Worn on left hand'], ['Left-hand throw', 'Worn on right hand']]
    : [['Throwing hand', 'Right-hand throw'], ['Worn on', 'Left hand']])]
});

export const productInfo = Object.freeze({
  black: {
    sizeFit: trainerFit,
    description: 'The BR-16 is built to make every defensive rep count. Its compact 10.25-inch design challenges players to develop cleaner transfers, more precise fielding mechanics, and greater control. Finished in black, red, and gray, the BR-16 brings a bold look to serious defensive work.',
    details: trainerDetails('Black / Red / Gray')
  },
  blue: {
    sizeFit: trainerFit,
    description: 'The OB-16 brings purpose to every defensive rep. With a compact 10.25-inch profile, it encourages players to sharpen their glove work, improve their transfers, and develop consistency through repetition. A combination of baby blue, royal blue, and navy gives the OB-16 its distinctive look.',
    details: trainerDetails('Baby Blue / Royal / Navy')
  },
  brown: {
    sizeFit: trainerFit,
    description: 'The CL-16 combines a classic leather-inspired colorway with a training-focused design. Its compact 10.25-inch profile makes defensive reps more demanding, encouraging clean fielding mechanics, controlled transfers, and consistent fundamentals. Built for players who put in the work.',
    details: trainerDetails('Brown / Dark Brown / Red')
  },
  'full-mint': {
    sizeFit: fullSizeFit('12', 'Pitcher', true),
    description: 'The MI-26 is a 12-inch pitcher’s glove crafted from Japanese Kip leather. Its closed web helps keep your grip concealed on the mound, while an external index finger hood accommodates players who prefer wearing their index finger outside the glove. Finished in mint and silver with a carved outer design.',
    details: ['Japanese Kip leather', 'Closed web with carved outer design', 'External index finger hood', 'Fur wrist lining', 'Mint / Silver colorway']
  },
  'full-black': {
    sizeFit: fullSizeFit('12.75', 'Outfield', true),
    description: 'Built for the outfield, the BL-50 combines a 12.75-inch profile with Japanese Kip leather and an open H-web. The longest glove in the ANAWIN Kip Series, it provides the extra length associated with an outfielder’s glove. A carved ANAWIN logo on the thumb completes its understated black design.',
    details: ['Japanese Kip leather', 'H-web', 'Carved ANAWIN thumb logo', 'Fur wrist lining', 'Black / White / Brown colorway']
  },
  'full-camel': {
    sizeFit: fullSizeFit('11.5', 'Infield', false),
    description: 'The CM-24 is a compact 11.5-inch infield glove built with Japanese Kip leather. Its Diamond web and dual welting give it a distinctive construction, while sheepskin-lined finger stalls and a moisture-wicking wrist pad complete the interior. A classic camel finish brings a timeless baseball look.',
    details: ['Japanese Kip leather', 'Diamond web', 'Dual welting', 'Sheepskin lining in all finger stalls', 'Moisture-wicking wrist pad', 'Camel / Red / Black colorway']
  },
  'full-orange': {
    sizeFit: fullSizeFit('11.75', 'Infield', true),
    description: 'The OR-17 is an 11.75-inch infield glove built with Japanese Kip leather and a Modified T-web. Its slightly longer profile offers an alternative to a more compact infield glove. Finished in orange with a carved ANAWIN logo on the thumb, the OR-17 combines a distinctive design with traditional glove construction.',
    details: ['Japanese Kip leather', 'Modified T-web', 'Carved ANAWIN thumb logo', 'Fur wrist lining', 'Orange / Gold / Chestnut Brown colorway']
  }
});
