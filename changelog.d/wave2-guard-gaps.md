### Security

- The Guard now reads more ways to send a secret file. It follows grouped short options of `curl`
  that end in the one that sends a file (`-sd @file`, `-sT file`, `-sF x=@file`), and it reads the
  code that starts a process inside `node -e`, `python3 -c`, `perl -e` and `osascript -e` as a
  command of its own. A request to take a secret and send it is also found with the verbs copy,
  gather, fetch and obtain, in English and in Portuguese. Each argument of a stdio MCP server that an
  agent saves stays one word, so the Guard reads the code of a `node -e` argument whole.
