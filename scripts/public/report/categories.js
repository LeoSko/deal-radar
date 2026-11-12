// Which cuisine a deal belongs to, the coarse Fast / Healthy meal groups above the
// cuisines, and the alcohol test. Client-side, from names: the providers do not agree
// on a taxonomy, and Foody's own one is in Greek.

// Alcohol (spirits, wine, beer) by name, or an explicit ABV such as "40% Vol". Hidden
// by default: a €249 brandy is not a lunch deal.
const ALCOHOL_RE = /\b(brandy|cognac|whisk(?:e)?y|vodka|\brum\b|\bgin\b|tequila|liqueur|liquor|aperol|campari|vermouth|prosecco|champagne|\bwine\b|merlot|cabernet|sauvignon|chardonnay|rioja|\bsekt\b|\bport\b|sherry|\bale\b|\blager\b|\bbeer\b|\bipa\b|\bstout\b|cider|\braki\b|ouzo|tsipouro|grappa|\bsake\b|bourbon|scotch|μπράντι|κονιάκ|ουίσκι|ουισκι|βότκα|βοτκα|ρούμι|τζιν|τεκίλα|κρασί|κρασι|μπύρα|μπυρα|λικέρ|ρακί|ούζο|τσίπουρο|σαμπάνια|προσέκο)\b/i;
const ABV_RE = /\d{1,2}(?:[.,]\d)?\s*%\s*(?:vol|abv|alc)/i;
export function isAlcohol(d) {
  const s = (d.name || "") + " " + (d.venue_name || "") + " " + (d.headline || "");
  return ALCOHOL_RE.test(s) || ABV_RE.test(s);
}

// Foody ships its own cuisine taxonomy (Greek) per venue - use it directly.
const FOODY_CAT = {
  'Πίτσα':'Pizza',
  'Μπέργκερς':'Burgers','Αμερικάνικη Κουζίνα':'Burgers',
  'Ασιατικά':'Sushi & Asian','Κινέζικα':'Sushi & Asian','Ιαπωνικά':'Sushi & Asian','Sushi':'Sushi & Asian','Ινδικά':'Sushi & Asian','Ταϊλανδέζικα':'Sushi & Asian',
  'Τηγανητό κοτόπουλο':'Chicken','Κοτόπουλο':'Chicken',
  'Ζυμαρικά':'Pasta & Italian','Ιταλική Κουζίνα':'Pasta & Italian','Ιταλικά':'Pasta & Italian',
  'Σχάρας':'Grill & Souvla','Ψησταριά':'Grill & Souvla','Γύρος':'Grill & Souvla','Μαγειρευτά':'Grill & Souvla','Σουβλάκι':'Grill & Souvla','Κυπριακή Κουζίνα':'Grill & Souvla','Ελληνική Κουζίνα':'Grill & Souvla',
  'Αραβική Κουζίνα':'Middle Eastern','Λιβανέζικα':'Middle Eastern',
  'Μεξικάνικα':'Mexican',
  'Θαλασσινά':'Seafood','Τηγανητό ψάρι':'Seafood','Ψάρι':'Seafood',
  'Σαλάτα':'Salad & Healthy','Σαλάτες':'Salad & Healthy','Υγιεινά':'Salad & Healthy',
  'Submarines':'Sandwiches & Wraps','Σάντουιτς':'Sandwiches & Wraps','Σάντουιτσ':'Sandwiches & Wraps',
  'Brunch':'Breakfast & Brunch','Πρόγευμα':'Breakfast & Brunch','Πρωινό':'Breakfast & Brunch',
  'Κρέπες':'Dessert & Bakery','Ζαχαροπλαστεία':'Dessert & Bakery','Παγωτό':'Dessert & Bakery','Κεραστικά':'Dessert & Bakery','Αλμυρά':'Dessert & Bakery','Γλυκά':'Dessert & Bakery',
  'Καφές':'Coffee & Café',
};
// Keyword fallback (English + Greek + cuisine + café/brand), specific → generic.
const CATS = [
  ['Pizza', /pizza|pizzeria|calzone|focaccia|pinsa|πίτσα|πιτσα/i],
  ['Sushi & Asian', /sushi|σούσι|σουσι|maki|sashimi|ramen|poke|\bbao\b|\bwok\b|asian|ασιατ|thai|ταϊλαν|noodle|νουντλ|dumpling|gyoza|teriyaki|katsu|\bpho\b|bibimbap|wagamama|hosomaki|nigiri|tempura|chinese|κινέζ|κινεζ|japan|ιαπων|korean|κορεά|vietnam|βιετναμ|\bmiso\b|tikka|korma|\bcurry\b|κάρυ|\bindia|ινδικ|edamame|kimchi|pad thai|tandoor|masala|mirch|biryani|izakaya|\boshi\b|yozen|dragon|mandarin|longzhu|chim chim|\braj\b|chettinad/i],
  ['Burgers', /burger|μπεργκ|μπέργκ|smash|cheeseburger|patty|whopper|μπιφτέκ|μπιφτεκ|hot ?dog|street dogs/i],
  ['Chicken', /chicken|κοτόπουλ|κοτοπουλ|wings|φτερούγ|nuggets|ναγκετ|tenders|goujons|popcorn chicken/i],
  ['Pasta & Italian', /pasta|ζυμαρικ|μακαρόν|μακαρον|carbonara|καρμπονάρ|bolognese|μπολονέζ|penne|rigatoni|lasagn|λαζάν|risotto|ριζότο|gnocchi|spaghetti|σπαγγ|tagliatelle|ravioli|tortellini|\bitalian\b|ιταλ|trattoria|τρατορ/i],
  ['Grill & Souvla', /kebab|κεμπάπ|grill|σχάρ|σχαρ|ψησταρ|psistaria|\bψητ|gyros|\bgyro\b|γύρο|γυρο|souvla|σουβλ|σεφταλ|sheftalia|κλεφτικ|kleftiko|χοιριν|μπριζόλ|μπριζολ|steak|\bbbq\b|brisket|lyulya|tavern|ταβέρν|μεζέ|\bmeze\b|halloumi|χαλούμ|μαγειρευτ|skepasti|σκεπαστ|θράκα|thraka|τυλιχτ|tylixto|μερακλ|meraklis|καρβουν|karvouno|κουζίν|kouzina|meet ?& ?eat|meat ?& ?eat|asado|georgian|tiflis|achapuri|khinkal|khachapuri|pelmeni|pushkin|berezka/i],
  ['Middle Eastern', /shawarma|σαουάρμ|σαουαρμ|arabic|αραβικ|lebanese|λιβανέζ|falafel|φαλάφελ|hummus|χούμους|manoushe|μανούς|\bsham\b|homse|zagros|kurdish|persian|περσικ|tahini|kofta|κοφτ|durum|σαμπλούκ|syrian|σύρι|sahten|damaskus|emessa|alsharq|\bcairo\b|halal|habibi|shawa|layalina|nazaret|levant|kilikia|armenian|αρμεν/i],
  ['Mexican', /taco|τάκο|burrito|μπουρίτο|quesadilla|nachos|νάτσος|mexic|μεξικ|fajita|φαχίτα|guacamole|tex.?mex|armadillo/i],
  ['Seafood', /seafood|θαλασσιν|\bfish\b|ψάρι|ψαρι|prawn|γαρίδ|γαριδ|shrimp|calamari|καλαμάρ|καλαμαρ|octopus|χταπόδ|mussel|μύδ|salmon|σολομ|\btuna\b|τόνο|lobster|αστακ|ocean basket|fishmarket|ψαραγορ|θαλασσοκ|seablings|gazebo mare/i],
  ['Salad & Healthy', /salad|σαλάτ|σαλατ|\bbowl\b|\bμπολ\b|quinoa|κινόα|healthy|υγιειν|\bvegan\b|βίγκαν|vegetar|χορτοφ|\bwrap\b|ράπ|avocado|αβοκάντο|\bpoke\b|protein|detox|\bfit\b|fitfork|nutri|wellness|\bnosh\b|foodness|acai|açai|oakberry/i],
  ['Sandwiches & Wraps', /submarine|sandwich|σάντουιτς|σαντουιτς|\bsub\b|\bsubs\b|baguette|μπαγκέτ|\btoast\b|τοστ|panini|πανίνι|\bpitta?\b|πίτα\b/i],
  ['Breakfast & Brunch', /brunch|breakfast|πρόγευμ|προγευμ|πρωιν|\beggs?\b|αυγά|αυγα|omelet|ομελέτ|ομελετ|pancake|πανκέικ|granola|γκρανόλα/i],
  ['Dessert & Bakery', /dessert|γλυκ|ζαχαροπλαστ|παγωτ|gelat|ice cream|κρέπ|κρεπ|crepe|crepa|crepoli|kreppa|waffle|βάφλ|βαφλ|\bcake\b|κέικ|τούρτ|τουρτ|brownie|μπράουν|cookie|μπισκότ|μπισκοτ|donut|ντόνατ|mochi|pastr|croissant|κρουασάν|κρουασαν|φούρνος|φουρν|αρτοπ|μπακλαβ|baklava|λουκουμάδ|μηλόπιτ|chocolate|σοκολάτ|σοκολατ|choco|\bsweet|confection|patisserie|tiramisu|cheesecake|κανταΐφ|τυρόπιτ|σπανακόπιτ|μπουγάτσ|cinnabon|glyko|glyka|γλυκοπωλ|häagen|haagen|bakery|\bbread\b|breadhouse|bagel|καραμελ|karamel|papafilippou/i],
  ['Coffee & Café', /coffee|καφέ|καφε\b|espresso|εσπρέσο|cappuc|καπουτσ|\blatte\b|λάτε|frappe|φραπέ|φραπε|nescafe|νεσκαφέ|\bmocha\b|μόκα|\bcafe\b|café|caffe|caferesto|coffice|kaffeine|pepcoff|goppion|costadoro|\blounge\b|\bbar\b|\bbeans\b|mikel|μάικελ|\bnero\b|νέρο|starbucks|costa coffee|coffee island|gloria jean|flat white|\btea\b|τσάι|τσαι|matcha|chai|smoothie|σμούθι|\bjuice\b|χυμ|\bboba\b|milkshake|μιλκσέικ|αναψυκτικ|lemonade|λεμονάδ|hojicha|macchiat|gastropub|biergarten|\bpub\b/i],
];
function rawCategoryOf(d) {
  const cu = (d.cuisine || '').trim();
  if (cu && FOODY_CAT[cu] && FOODY_CAT[cu] !== 'Other') return FOODY_CAT[cu];
  const s = (d.name + ' ' + (d.venue_name||'') + ' ' + (d.headline||'') + ' ' + cu).toLowerCase();
  for (const [name, re] of CATS) if (re.test(s)) return name;
  return 'Other';
}
// Category emoji + the coarse Fast/Healthy grouping above them. The derivation above
// owns which names can appear, this owns how they are presented.
export const CAT_EMOJI = {
  'Pizza':'🍕','Burgers':'🍔','Sushi & Asian':'🍣','Chicken':'🍗','Pasta & Italian':'🍝',
  'Grill & Souvla':'🥙','Middle Eastern':'🧆','Mexican':'🌮','Seafood':'🦐','Salad & Healthy':'🥗',
  'Sandwiches & Wraps':'🥪','Breakfast & Brunch':'🍳','Dessert & Bakery':'🍰','Coffee & Café':'☕','Other':'🍽️',
};
export const FOOD_GROUPS = [
  { id:'fast', label:'Fast food', emoji:'🍟', cats:['Pizza','Burgers','Chicken','Mexican','Sandwiches & Wraps','Dessert & Bakery'] },
  { id:'healthy', label:'Healthy food', emoji:'🥗', cats:['Sushi & Asian','Pasta & Italian','Grill & Souvla','Middle Eastern','Seafood','Salad & Healthy','Breakfast & Brunch'] },
];
const CAT_GROUP = new Map();        // category name -> group id
for (const g of FOOD_GROUPS) for (const c of g.cats) CAT_GROUP.set(c, g.id);
export const groupCats = (gid) => (FOOD_GROUPS.find((g) => g.id === gid) || {}).cats || [];
// Cross-provider inheritance: a Bolt venue-name-only deal ("Tiflis") inherits the
// category derived for the same venue on Foody/Wolt (joined by venue_key).
let venueCat = new Map();
export function buildVenueCats(deals) {
  venueCat = new Map();
  for (const d of deals) {
    const c = rawCategoryOf(d);
    if (c !== "Other" && d.venue_key && !venueCat.has(d.venue_key)) venueCat.set(d.venue_key, c);
  }
}
export function categoryOf(d) {
  const c = rawCategoryOf(d);
  if (c !== "Other") return c;
  return (d.venue_key && venueCat.get(d.venue_key)) || "Other";
}
export const foodGroupOf = (d) => CAT_GROUP.get(categoryOf(d)) || "";
