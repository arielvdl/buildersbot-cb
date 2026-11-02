### Added

- Act on a card of the Feed page without leaving it. Approve or deny an approval, answer a simple
  question (choose an option or type an answer), stop a run, and resume a stopped task or give it to
  another agent. A question with more than one part opens its conversation, as before.
- Select stopped tasks on the Feed page and resume them all, or give them all to one agent.
- Keys on a focused card: J and K go to the next and the previous card, A approves, N denies, R
  resumes.
- The card changes at once. If the action cannot be done, for example because the request was
  answered in the meantime, the card goes back and says why.

### Security

- An approval of the Guard, a request for more access and a file change outside the workspace show
  their reason and need a second, explicit step on the card. N opens a confirmation and never denies
  by itself.
- The Feed sends only the ids of the cards. The app checks each card again: the request must still
  wait, for the same agent and conversation, on this computer. A repeated action does nothing. The
  cards of a joined server offer no action; their conversation answers them, as before.
