# Bottle Public Contracts Are Provider-Neutral

Bottle supports concrete Agent Providers such as Claude and Codex, but its public runtime contract uses Bottle and agent terminology for shared concepts. Commands, modes, session identifiers, client helpers, web chat contracts, and server/config helpers should not be named after a provider unless the value specifically selects or configures that provider.
