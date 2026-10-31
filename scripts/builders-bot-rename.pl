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
# and the Worker also read the upstream names. A header name is `X-OpenBot-` and a capital
# letter anywhere, or `OpenBot-` and one of the published names in `@published` below
# (`"OpenBot-Timestamp"`). Add a new published header name to that list.
# Other text with a dash is prose and is still renamed, also in quotes: the German
# `"OpenBot-Website"` becomes `"Builders Bot-Website"`, and `im OpenBot-Browser` and
# `dist/OpenBot-Host-arm64.pkg` change too.
#
# Never pass a vendored or checksummed file through this filter: `vendor/**`, the patches and
# overrides that `native-runtime.lock.json` lists. A renamed patch no longer matches its sha256 and
# the package step fails. `scripts/native-runtime-lock-files.test.ts` fails when that happens.
#
# The Linux server and its Docker image also keep the upstream names in `@kept_paths`: the
# install folder and the AppImage file that docker/Dockerfile copies. Unquoted shell, systemd
# units, AppArmor profiles and Dockerfile lines use them, and a space breaks each of these.
# scripts/check-linux-image-names.ts reads this list.
#
# Usage: perl scripts/builders-bot-rename.pl < file
local $/;
my $s = <>;
my $header = "\x{1}OPENBOT_HEADER\x{1}";
my @published = qw(
  Protocol-Version App-Version Capabilities Timestamp Signature Logo-Version
  Hosting-Developer-Key Host-Id Host-Token
);
my @kept_paths = ("/opt/OpenBot", "OpenBot.AppImage");
my $published = join "|", map { quotemeta } @published;
for my $index (0 .. $#kept_paths) {
  my $path = quotemeta $kept_paths[$index];
  $s =~ s/(?<![A-Za-z0-9])$path(?![A-Za-z0-9])/\x{1}OPENBOT_PATH_$index\x{1}/g;
}
$s =~ s/(?<=X-)OpenBot(?=-[A-Z])/$header/g;
$s =~ s/(?<![A-Za-z0-9-])OpenBot(?=-(?:$published)\b)/$header/g;
$s =~ s/OpenBot(?=[A-Z])/BuildersBot/g;
$s =~ s/\bOpenBot\b/Builders Bot/g;
$s =~ s/\Q$header\E/OpenBot/g;
$s =~ s/\x{1}OPENBOT_PATH_(\d+)\x{1}/$kept_paths[$1]/g;
print $s;
