#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// `fd rehearse`: mameko's `<cli>`, built as `fd`, runs this executable from PATH (MAMEKO-REL-039).
import { main } from "../src/main.ts";

main("rehearse");
