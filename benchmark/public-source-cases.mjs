const rfc = (number) => `https://www.rfc-editor.org/rfc/rfc${number}.html`;

// The fixture text is original and deliberately small. Reference criteria
// are based on the cited sections and are also checked against live reads.
export const publicSourceCases = [
  {
    id: "robots-authorization",
    source: `${rfc(9309)}#section-1`,
    question: "Do the Robots Exclusion Protocol rules authorize access?",
    focus: "rules not form of access authorization",
    requiredText: [/not (?:a form of )?access authorization/iu],
    fixtureText: "Rules for cooperative crawlers\nRobots rules are not access authorization.",
  },
  {
    id: "rate-limit-retry-after",
    source: `${rfc(6585)}#section-4`,
    question: "Is Retry-After mandatory in an HTTP 429 response?",
    focus: "response representations SHOULD include details explanatory condition MAY Retry-After header",
    requiredText: [/may (?:include|carry) (?:a )?retry-after/iu],
    fixtureText: "Rate limit response\nA 429 response may carry a Retry-After header to advise a waiting period.",
  },
  {
    id: "normative-uppercase",
    source: `${rfc(8174)}#section-2`,
    question: "When do the BCP 14 requirement words have their defined normative meanings?",
    focus: "meanings specified herein only when all capitals",
    requiredText: [/(?:only when|only in|only apply in) (?:they (?:appear|are) in )?(?:all capitals|uppercase)/iu],
    fixtureText: "Normative words\nThe defined meanings apply only in uppercase.",
  },
  {
    id: "json-public-encoding",
    source: `${rfc(8259)}#section-8.1`,
    question: "What encoding does RFC 8259 require for JSON exchanged outside a closed ecosystem?",
    focus: "JSON text exchanged systems not part closed ecosystem encoded using UTF-8",
    requiredText: [/(?:not part of a|outside a) closed ecosystem/iu, /must (?:be encoded using|use) utf-8/iu],
    fixtureText: "Text encoding\nJSON exchanged outside a closed ecosystem must use UTF-8.",
  },
  {
    id: "cbor-design",
    source: `${rfc(8949)}#abstract`,
    question: "Does CBOR aim to allow extension without requiring version negotiation?",
    focus: "representation data format design goals small code size extensibility without need version negotiation",
    requiredText: [/(?:extensibility|extension) without (?:the need for )?version negotiation/iu],
    fixtureText: "CBOR goals\nThe binary format supports extension without version negotiation.",
  },
  {
    id: "node-https-transport",
    source: "https://nodejs.org/download/release/v22.13.0/docs/api/https.html#https",
    question: "What transport protection does the Node.js 22.13.0 HTTPS module describe?",
    focus: "HTTPS HTTP protocol over TLS SSL separate module",
    requiredText: [/http (?:protocol )?over tls(?:\/ssl)?/iu],
    fixtureText: "Node HTTPS\nThe separate HTTPS module implements HTTP over TLS.",
  },
];
