# Security policy

## Reporting a vulnerability

Please report security problems through GitHub's private vulnerability
reporting ("Report a vulnerability" on the Security tab), not in a public
issue. Include the mod, the exact command or file text, and what you expected
the mod to do.

## Scope

In scope: an ordinary command or edit that a guard should deny but lets
through, a mod that sends or writes data it should not (for example
tf-plan-summary returning an attribute value), and a mod that fails open
when it errors.

Out of scope: the limits listed under "Known limits" in the README, such as
commands assembled at run time from variables or scripts. The mods are
guardrails against an agent's mistakes, not a security boundary.
