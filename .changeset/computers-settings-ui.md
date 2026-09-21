---
'@truefoundry/trueforge-ui': patch
---

Settings gains a **Computers** section where an admin enrolls a machine, reads what it reported (hostname, OS, client version, run-as user, detected tools, last seen), says which saved agents may use it, and reads what has run on it. Creating a computer, or rotating its enrollment, shows the install command and the Docker command once, each with a copy button; the panel stays put until it is dismissed, because the code inside it cannot be read again. Rotate and revoke each ask first, delete is refused while an agent is still granted, and the section says plainly that this is a real machine, that commands run as the client's user, and that granting an agent trusts everyone who can edit it. The agent's sandbox settings gain a **Run on** control that offers the tenant sandbox or one of the computers that agent has been granted. The section appears only when the host supplies the new optional `computerCatalog` slot.
