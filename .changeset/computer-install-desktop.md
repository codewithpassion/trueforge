---
'@truefoundry/trueforge': patch
---

`install.sh --desktop` checks for Xvfb, openbox, xterm, chromium, xdotool and xclip, prints the `apt-get` line and stops if any is missing, and enrolls the computer with its virtual desktop turned on.
