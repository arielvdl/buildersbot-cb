### Added

- A server can have a model policy: a file that its administrator writes on the host. The picker of
  the server then offers only the providers and models that the policy allows, and the free models
  of Builders are hidden. A provider that the policy does not allow is off and cannot be turned on.
- On a server with a model policy, the Cultura Builder models are the models that the Cultura
  Builder Hub allows for the signed-in account. A model that the Hub grants only to some people
  shows only for them.

### Security

- A model policy file that is not valid offers only the Cultura Builder gateway. It does not open
  every provider.
- In a container of `openbot-instance`, the model policy is in a read-only folder, so an agent cannot
  change it.
