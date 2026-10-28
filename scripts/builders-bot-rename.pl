#!/usr/bin/perl
# Re-applies the Builders Bot rename to a file after a merge from upstream Open Bot.
#
# The clone keeps the upstream project name in package scopes, file names, URL schemes
# and environment variables, and uses Builders Bot in identifiers and in prose. So the
# rule is narrow on purpose: an `OpenBot` that continues into a capital letter is an
# identifier and becomes `BuildersBot`; a standalone `OpenBot` is prose and becomes
# `Builders Bot`. Lowercase `openbot` and `OPENBOT_` stay as they are.
#
# Usage: perl scripts/builders-bot-rename.pl < file
local $/;
my $s = <>;
$s =~ s/OpenBot(?=[A-Z])/BuildersBot/g;
$s =~ s/\bOpenBot\b/Builders Bot/g;
print $s;
