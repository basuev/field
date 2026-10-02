# Canonical commitments

Task and report objects are strict versioned JSON at the API boundary. Their commitments are SHA-256 over the binary encoding below, not JSON text. JSON key order therefore cannot affect a commitment. Reject unknown fields, noncanonical wallet addresses, non-NFC text, leading or trailing whitespace and invalid Unicode. Do not silently normalize content after a person approved it.

All numeric timestamps are nonnegative whole Unix seconds within JavaScript's safe integer range. Price is a positive canonical decimal string within `u64`, with no leading zeros. Binary integers are little-endian. Strings have a `u32` UTF-8 byte-length prefix, followed by those bytes. JSON text limits count JavaScript UTF-16 code units, while the binary prefix counts bytes. UUIDs use lowercase canonical text at the API boundary and their 16 left-to-right hexadecimal bytes on the wire, not GUID mixed-endian order.

The null byte in each domain is one literal zero byte. No delimiters, padding, BOM or trailing bytes are added. The deployed program and network are part of the task commitment. Changing either requires a new quote.

## Task v1

Concatenate these fields in this order.

1. UTF-8 `Field/task/v1` followed by a null byte.
2. Length-prefixed `solana:devnet`.
3. The 32-byte escrow program address.
4. The 16-byte task UUID.
5. Requester, executor and reviewer public keys, each 32 bytes.
6. Task price as `u64`.
7. Issued time, quote expiry, execution deadline, review deadline and resolution deadline, each `u64`.
8. Length-prefixed cafe name and cafe address.

Kind `cafe-laptop-check` and schema version `1` are implicit in the domain. Version 1 always asks about a free table for one laptop user, permission to use a laptop, guest Wi-Fi availability and an accessible outlet at a suitable place. Asking staff is sufficient. It does not require connection or speed testing, booking or a promise about availability on arrival. Changing these semantics requires a new schema/domain version, not a different interpretation of the same hash.

The three wallets must be distinct signing wallets. For this demo the requester also operates the reviewer role with a separate test wallet. Price excludes transaction fees and rent. The task ID must be nonzero.

## Report v1

Concatenate these fields in this order.

1. UTF-8 `Field/report/v1` followed by a null byte.
2. The 16-byte task UUID.
3. The 32-byte canonical task commitment.
4. The 32-byte executor public key.
5. Report creation time as `u64`.
6. Four observation records in the fixed order below.
7. Length-prefixed notes, including a zero length for empty notes.

The observation order is `freeTable`, `laptopAllowed`, `guestWifi`, `outlet`. Each record contains one attempted byte with value `1`, one answer byte, one source byte, an observation time as `u64` and a length-prefixed missing-answer reason.

Answer byte values are `yes = 0`, `no = 1`, `unknown = 2`. Source byte values are `observation = 0`, `staff = 1`, `unavailable = 2`. Unknown answers require a nonempty reason. Yes and no answers have an empty missing-answer reason. Unavailable source can only accompany unknown. A negative answer can fulfill the task. Staff Wi-Fi testimony does not mean the network was tested.

All four agreed criteria must have been attempted. This is an executor assertion, not a fact established by a boolean or the chain. Observation times must not follow report creation or precede task issuance. Report creation must precede the execution deadline. The demo permits observations between task issuance and funding. The chain separately checks when the executor commits the report. It does not verify the reported observation times.

The report must match the task ID, task hash and designated executor. Store the exact immutable report before asking the executor to commit its hash. A hash is not encryption. Access to the offchain task and report still needs role authorization.

## Compatibility checks

`fixtures/protocol-v1.json` contains synthetic multilingual data, fixed encoded bytes, SHA-256 commitments, derived address and all instruction payloads/account lists. TypeScript checks bytes and computes hashes with both Web Crypto and Node crypto. Rust checks the same hashes, derived address, Anchor instruction serialization, account lists and funded-account serialization against the frozen vectors. The client account verifier checks the complete canonical task binding before reporting business state. Neither serialized bytes nor a locally constructed fixture establish that such an account exists on devnet.

Do not regenerate vectors to make a failing test pass. Investigate whether a semantic change requires a new schema version. The financial instruction format follows Anchor's discriminator and Borsh encoding. A fund instruction includes the task ID/hash, fixed executor/reviewer, price and four financial deadlines. Requester authority comes from its signing account, not a freely supplied argument.
