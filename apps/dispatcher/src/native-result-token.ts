import { Option, Schema } from "effect";
import { NativeReadBinding, NativeReceiptRefused, nativeReadMessage } from "@fractalboxdev/flare-dispatch-core";
import { makeCapabilityToken } from "./capability-token";

const capability = makeCapabilityToken("flare-dispatch/native-result-reader/v1");
const decode = Schema.decodeUnknownOption(NativeReadBinding, { onExcessProperty: "error" });

/** The complete immutable request and absolute expiry share one signed message. */
export const signNativeResultToken = (ikm: string, binding: NativeReadBinding): Promise<string> =>
  ikm.length === 0
    ? Promise.reject(new NativeReceiptRefused({ reason: "native reader signing configuration unavailable" }))
    : capability.sign(ikm, nativeReadMessage(Schema.decodeUnknownSync(NativeReadBinding)(binding)))
    .then((token) => `Bearer ${token}`);

/** Reader credentials occur only in Authorization; equality with the deadline refuses. */
export const verifyNativeResultToken = async (
  ikm: string, rawBinding: unknown, authorization: string | null | undefined, now: number,
): Promise<boolean> => {
  return Option.match(decode(rawBinding), {
    onNone: () => Promise.resolve(false),
    onSome: (binding) => {
      if (ikm.length === 0 || !Number.isSafeInteger(now) || now < 0 || now >= binding.expires_at
        || typeof authorization !== "string" || !/^Bearer [A-Za-z0-9_-]{22}$/.test(authorization)) {
        return Promise.resolve(false);
      }
      return capability.verify(ikm, nativeReadMessage(binding), authorization.slice(7));
    },
  });
};
