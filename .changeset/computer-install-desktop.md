---
'@truefoundry/trueforge': patch
---

`install.sh --desktop` checks for Xvfb, openbox, xterm, chromium, xdotool and xclip, prints the Debian `apt-get` line and stops if any is missing, refuses Ubuntu's snap chromium, and enrolls the computer with its virtual desktop turned on.
