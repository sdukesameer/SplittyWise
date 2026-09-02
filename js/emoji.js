// ---------------------------------------------------------------------------
//  Emoji — guessed from the description, overridable from a picker
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  // Ordered most specific first: the first pattern to match wins, so
  // "chai" beats the generic drink rule and "petrol pump" beats "pump".
  // Written for how bills actually get described in India.
  const RULES = [
    // --- food & drink ---
    [/\b(chai|tea|kadak)\b/,                                    '☕'],
    [/\b(coffee|latte|cappuccino|espresso|ccd|starbucks)\b/,     '☕'],
    [/\b(biryani|biriyani|pulao|rice|thali|dal|curry|sabji)\b/,  '🍛'],
    [/\b(pizza|dominos|domino)\b/,                               '🍕'],
    [/\b(burger|mcd|mcdonald|kfc|wrap)\b/,                       '🍔'],
    [/\b(maggi|noodles|ramen|chowmein|hakka)\b/,                 '🍜'],
    [/\b(momo|momos|dumpling|sushi)\b/,                          '🥟'],
    [/\b(dosa|idli|vada|uttapam|sambar)\b/,                      '🥞'],
    [/\b(samosa|pakora|chaat|pani\s?puri|snack|snacks|chips)\b/, '🍿'],
    [/\b(cake|pastry|birthday)\b/,                               '🎂'],
    [/\b(ice\s?cream|icecream|kulfi|gelato)\b/,                  '🍦'],
    [/\b(sweet|sweets|mithai|laddu|jalebi|dessert)\b/,           '🍮'],
    [/\b(breakfast|omelette|egg|eggs|anda)\b/,                   '🍳'],
    [/\b(lunch|dinner|brunch|meal|food|restaurant|hotel\s?bill|swiggy|zomato|zepto)\b/, '🍽️'],
    [/\b(beer|drinks|bar|pub|whisky|wine|vodka|rum|booze|party)\b/, '🍻'],
    [/\b(juice|shake|smoothie|lassi|soda|coke|pepsi|thums)\b/,   '🥤'],
    [/\b(milk|curd|dahi|paneer|cheese|butter|dairy|amul)\b/,     '🥛'],
    [/\b(chicken|mutton|meat|fish|kebab|tikka|non\s?veg)\b/,     '🍗'],
    [/\b(fruit|fruits|apple|banana|mango|watermelon)\b/,         '🍎'],
    [/\b(vegetable|vegetables|sabzi|sabji|bhaji|veggies)\b/,     '🥦'],

    // --- household ---
    [/\b(grocery|groceries|kirana|bigbasket|blinkit|instamart|supermarket|dmart)\b/, '🛒'],
    [/\b(rent|deposit|landlord|maintenance)\b/,                  '🏠'],
    [/\b(electric|electricity|current|power\s?bill|bescom|meter)\b/, '💡'],
    [/\b(water|tanker|bisleri|ro\b)/,                            '🚰'],
    [/\b(gas|cylinder|lpg|indane)\b/,                            '🔥'],
    [/\b(internet|wifi|broadband|fiber|fibre|jio|airtel|act\b|hathway)/, '🌐'],
    [/\b(recharge|mobile|phone\s?bill|postpaid|prepaid|sim)\b/,  '📱'],
    [/\b(maid|cleaner|cleaning|sweeper|bai|housekeeping)\b/,     '🧹'],
    [/\b(laundry|dhobi|ironing|washing)\b/,                      '🧺'],
    [/\b(repair|plumber|electrician|carpenter|fix|service)\b/,   '🔧'],
    [/\b(furniture|mattress|sofa|ikea)\b/,                       '🛋️'],

    // --- travel ---
    [/\b(petrol|diesel|fuel|pump)\b/,                            '⛽'],
    [/\b(auto|rickshaw|ola|uber|cab|taxi|rapido)\b/,             '🛺'],
    [/\b(train|railway|irctc|metro|local)\b/,                    '🚆'],
    [/\b(flight|plane|airport|indigo|vistara|air\s?india)\b/,    '✈️'],
    [/\b(bus|volvo|redbus|ksrtc)\b/,                             '🚌'],
    [/\b(toll|fastag|highway)\b/,                                '🛣️'],
    [/\b(parking|valet)\b/,                                      '🅿️'],
    [/\b(bike|scooter|scooty|activa|cycle)\b/,                   '🛵'],
    [/\b(stay|airbnb|resort|lodge|hostel|oyo|hotel)\b/,          '🏨'],
    [/\b(trip|travel|tour|vacation|holiday|goa|manali)\b/,       '🧳'],

    // --- life ---
    [/\b(medicine|medicines|pharmacy|chemist|tablet|apollo|1mg)\b/, '💊'],
    [/\b(doctor|hospital|clinic|dentist|checkup|test|scan)\b/,   '🏥'],
    [/\b(gym|fitness|protein|workout|cult)\b/,                   '🏋️'],
    [/\b(movie|cinema|pvr|inox|imax|ticket|tickets)\b/,          '🎬'],
    [/\b(netflix|prime|spotify|hotstar|subscription|youtube)\b/, '📺'],
    [/\b(game|gaming|steam|playstation|xbox)\b/,                 '🎮'],
    [/\b(book|books|stationery|notebook|pen)\b/,                 '📚'],
    [/\b(course|class|tuition|fees|exam|college)\b/,             '🎓'],
    [/\b(shopping|amazon|flipkart|myntra|clothes|shirt|shoes|dress)\b/, '🛍️'],
    [/\b(salon|haircut|barber|parlour|spa)\b/,                   '💈'],
    [/\b(gift|present|anniversary|wedding|shagun)\b/,            '🎁'],
    [/\b(insurance|premium|policy|lic\b)/,                       '🛡️'],
    [/\b(tax|gst|fine|penalty|challan)\b/,                       '🧾'],
    [/\b(pet|dog|cat|vet)\b/,                                    '🐾'],
    [/\b(plant|plants|garden|nursery)\b/,                        '🪴'],
    [/\b(cash|atm|withdraw|upi|transfer|paid|payment|lent|borrow)\b/, '💸'],
  ];

  const FALLBACK = '🧾';

  SW.guessEmoji = function (description) {
    const text = String(description || '').toLowerCase();
    if (!text.trim()) return FALLBACK;
    for (let i = 0; i < RULES.length; i++) {
      if (RULES[i][0].test(text)) return RULES[i][1];
    }
    return FALLBACK;
  };

  // Picker groups, which double as spending categories: an expense's
  // category is whichever group its emoji belongs to. One list, so the
  // picker and the charts can never disagree about what counts as food.
  // Every emoji appears in exactly one group (asserted in the tests).
  SW.EMOJI_GROUPS = [
    { label: 'Groceries',   items: '🛒 🥦 🍎 🥛'.split(' ') },
    { label: 'Food & drink', items: '🍽️ 🍕 🍔 🍛 🍜 🥟 🥞 🍗 🍳 🍿 🎂 🍦 🍮 ☕ 🥤 🍻'.split(' ') },
    { label: 'Home & bills', items: '🏠 💡 🚰 🔥 🌐 📱 🧹 🧺 🔧 🛋️ 🪴 🧾'.split(' ') },
    { label: 'Travel',      items: '⛽ 🛺 🚆 ✈️ 🚌 🛣️ 🅿️ 🛵 🏨 🧳 🚗 ⛴️'.split(' ') },
    { label: 'Life & fun',  items: '💊 🏥 🏋️ 🎬 📺 🎮 📚 🎓 🛍️ 💈 🎁 🛡️ 🐾 💸'.split(' ') },
    { label: 'Other',       items: '⭐️ 💎 🎯 🎉 ❤️ 🙌 👍 ⚡️ 🌈 🍀 🧿'.split(' ') },
  ];

  // emoji -> category label.
  const BY_EMOJI = {};
  SW.EMOJI_GROUPS.forEach(function (g) {
    g.items.forEach(function (e) { BY_EMOJI[e] = g.label; });
  });

  SW.CATEGORIES = SW.EMOJI_GROUPS.map(function (g) { return g.label; });

  // An expense stores its own category, but anything created before
  // categories existed falls back to whatever its emoji implies.
  SW.categoryOf = function (expense) {
    const stored = expense && expense.category;
    if (stored && stored !== 'general') {
      // A built-in name, or one of your own — both are just text here, so a
      // category you added is honoured without any migration.
      if (SW.CATEGORIES.indexOf(stored) > -1) return stored;
      const mine = (SW.ledger && SW.ledger.categories) || [];
      if (mine.some(function (c) { return c.name === stored; })) return stored;
    }
    return BY_EMOJI[(expense && expense.emoji) || ''] || 'Other';
  };

  SW.categoryForEmoji = function (emoji) { return BY_EMOJI[emoji] || 'Other'; };

  SW.guessCategory = function (description) {
    return BY_EMOJI[SW.guessEmoji(description)] || 'Other';
  };
})();
