### Fixed

- The example settings of the remote host (`remote/.env.example`) now point the ticket keys and the
  account service to the Builders Bot account server. Before, they pointed to the OpenBot server,
  so a host that copied them would reject every ticket.
