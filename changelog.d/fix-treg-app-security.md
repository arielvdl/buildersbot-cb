### Fixed

- A paid data connection call refuses a URL of a private or local address also when the URL has no
  `//` or has a `\`, such as `http:\\10.0.0.1` or `https:192.168.0.10`.
- The result of a paid data connection hides the signature of a signed link (`X-Amz-Signature`,
  `sig`, also when the name is percent-encoded) and every value in a field that holds a credential,
  numbers and nested values too.
- A routine that Builders Bot did not see you save, such as one from an import, a template or the
  marketplace, uses no paid data connection until you save it in Routines. A copy of an agent keeps
  the connection limits of its routines.
- When you change only the name, the schedule or the state of a routine that a team member wrote,
  the routine still uses no paid data connection.
- A team member's edit of a queued routine step, a team member's webhook test event, and a webhook
  request signed with a secret that a team member got no longer let the routine, or the next steps
  of its flow, use paid data connections.
