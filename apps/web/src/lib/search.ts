/** Keyword matching for searchable pickers (accounts, contacts). */

export interface SearchOption {
  value: string;
  /** What the option shows, e.g. "6100 · Software and Subscriptions". */
  label: string;
  /** Heading the option is listed under when nothing is typed. Options in a group must be adjacent. */
  group?: string;
  /** Extra words that match but aren't shown: synonyms, the account description, the type. */
  keywords?: string;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Score an option against a query, or null when it doesn't match. Every word typed must match: as the
 * start of a word in the label (strongest), the start of a keyword, or anywhere inside the label. So
 * "tel" finds "Telephone and Internet", "61" finds the 61xx codes, and "soft sub" or "adobe" find
 * "Software and Subscriptions".
 */
export function matchScore(o: SearchOption, query: string): number | null {
  const q = words(query);
  if (q.length === 0) return 0;
  const labelWords = words(o.label);
  const keywordWords = words(`${o.group ?? ""} ${o.keywords ?? ""}`);
  const flatLabel = labelWords.join(" ");
  let score = 0;
  for (const t of q) {
    if (labelWords.some((w) => w === t)) score += 4;
    else if (labelWords.some((w) => w.startsWith(t))) score += 3;
    else if (keywordWords.some((w) => w.startsWith(t))) score += 2;
    else if (t.length >= 2 && flatLabel.includes(t)) score += 1;
    else return null;
  }
  // Typing the start of the label (usually the account code) ranks first.
  if (flatLabel.startsWith(q.join(" "))) score += 5;
  // Among equal word matches the closer one wins: "sales" puts "Sales" before "Sales Tax Payable".
  // Code searches ("61") keep chart order.
  return q.every((t) => /^\d+$/.test(t)) ? score : score - labelWords.length / 100;
}

/** Matching options, best first; ties keep their original order. */
export function filterOptions<T extends SearchOption>(options: T[], query: string): T[] {
  if (!words(query).length) return options;
  return options
    .map((o, i) => ({ o, i, s: matchScore(o, query) }))
    .filter((x): x is { o: T; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.o);
}

/**
 * Everyday words people type for common accounts, matched against the account name. The chart of
 * accounts only has names, so without these "internet" or "coffee" would find nothing useful.
 */
const ACCOUNT_SYNONYMS: [RegExp, string][] = [
  [/software|subscription/i, "saas app apps license cloud hosting adobe figma github google microsoft"],
  [/telephone|internet|phone/i, "cell mobile wifi broadband isp comcast verizon att"],
  [/meal/i, "food lunch dinner coffee restaurant client entertainment"],
  [/travel/i, "flight airfare airline hotel lodging uber lyft taxi train"],
  [/\b(car|truck|vehicle|auto)\b/i, "gas fuel mileage parking tolls"],
  [/advertising|marketing/i, "ads google facebook meta promotion"],
  [/legal|professional/i, "lawyer attorney accountant cpa bookkeeper consultant"],
  [/contract labor/i, "contractor freelancer 1099 upwork fiverr"],
  [/office expense/i, "stationery printer ink"],
  [/supplies/i, "materials"],
  [/postage|shipping/i, "usps ups fedex dhl mail courier"],
  [/merchant|bank (and )?(fees|charges)/i, "stripe paypal square fee fees charges"],
  [/\brent\b/i, "lease office space coworking"],
  [/utilit/i, "electric electricity water gas power"],
  [/insurance/i, "liability premium policy"],
  [/education|training/i, "course books conference seminar"],
  [/dues|membership/i, "association subscription club"],
  [/taxes|licenses/i, "permit registration franchise tax"],
  [/wages|payroll/i, "salary payroll staff employees"],
  [/contribution|capital/i, "investment equity"],
  [/draw|distribution/i, "owner withdrawal personal"],
  [/\b(sales|revenue|consulting)\b(?!.*\b(tax|cost)\b)/i, "income invoice client customer"],
  [/credit card/i, "amex visa mastercard card"],
  [/checking|savings/i, "bank cash"],
  [/repairs|maintenance/i, "fix service"],
  [/equipment/i, "computer laptop hardware"],
  [
    /due to (owner|partner|shareholder)/i,
    "reimbursement reimburse out of pocket owed personal card expense report",
  ],
  [
    /organization|startup|start-up|formation/i,
    "llc formation incorporation incorporate registered agent filing fee articles",
  ],
];

export function accountKeywords(name: string): string {
  return ACCOUNT_SYNONYMS.filter(([re]) => re.test(name))
    .map(([, k]) => k)
    .join(" ");
}
