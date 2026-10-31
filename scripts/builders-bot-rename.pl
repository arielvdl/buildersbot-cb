#!/usr/bin/perl
# Re-applies the Builders Bot rename to a file after a merge from upstream Open Bot.
#
# The clone keeps the upstream project name in package scopes, file names, URL schemes
# and environment variables, and uses Builders Bot in identifiers and in prose. So the
# rule is narrow on purpose: an `OpenBot` that continues into a capital letter is an
# identifier and becomes `BuildersBot`; a standalone `OpenBot` is prose and becomes
# `Builders Bot`. Lowercase `openbot` and `OPENBOT_` stay as they are.
#
# HTTP header names keep `OpenBot`: a header name cannot hold a space, and `fetch`, `Headers`
# and Node refuse a name with a space before they send anything. Released hosts, phones
# and the Worker also read the upstream names. A header name is `X-OpenBot-` anywhere, or
# `OpenBot-` and a capital letter just after a quote or a backtick (`"OpenBot-Timestamp"`).
# Prose such as `im OpenBot-Browser` has a space before it and is still renamed.
#
# Usage: perl scripts/builders-bot-rename.pl < file
local $/;
my $s = <>;
my $header = "\x{1}OPENBOT_HEADER\x{1}";
$s =~ s/(?:(?<=X-)|(?<=["'`]))OpenBot(?=-[A-Z])/$header/g;
$s =~ s/OpenBot(?=[A-Z])/BuildersBot/g;
$s =~ s/\bOpenBot\b/Builders Bot/g;
$s =~ s/\Q$header\E/OpenBot/g;
print $s;
