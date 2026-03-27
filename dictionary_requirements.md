Here's the full description of how DICT_ZLIB works, precise enough for the agent to implement from scratch if it's missing.

DICT_ZLIB Codec: How It Works
The goal is to exploit word-level repetition in natural language text, which zlib alone doesn't fully capitalize on because zlib operates on byte patterns with a limited lookback window. Tokenizing first and then compressing the token index stream gives significantly better compression on repetitive prose.
Encode steps:

Tokenize the input text, splitting on whitespace but preserving punctuation as separate tokens. For example, "In the beginning, God" becomes ["In", "the", "beginning,", "God"]. Do not strip punctuation -- keep it attached to the word or as its own token so the original text reconstructs exactly.
Build a vocabulary list of every unique token in the document, sorted alphabetically for determinism. Assign each token a numeric index (0, 1, 2...).
Replace every token in the document with its 2-byte unsigned short index (Uint16Array). This works up to 65,535 unique tokens -- more than enough for any natural language document.
Serialize the vocabulary as a length-prefixed binary block: first a 2-byte unsigned short indicating how many words are in the vocabulary, then each word as a null-terminated UTF-8 string. This dictionary block travels with the payload in symbol 0.
Apply zlib deflate at level 9 to the packed index array.
Final payload structure per encode operation:

[2-byte vocab count][null-terminated word 0][null-terminated word 1]...[zlib-compressed Uint16Array of token indices]
The boundary between the dictionary block and the compressed index array is determined by reading exactly vocabCount null-terminated strings, then treating the remainder as the zlib stream.
Decode steps:

Read the 2-byte vocab count from the start of the reassembled payload.
Read exactly that many null-terminated UTF-8 strings to reconstruct the vocabulary array.
Decompress the remainder with zlib inflate to get the Uint16Array of token indices.
Map each index back to its token in the vocabulary array.
Join tokens with spaces to reconstruct the original text.

Why this beats raw zlib on text: zlib's LZ77 lookback window is 32KB. In a long document, the word "the" appearing 500 times scattered across 100KB will only get compression credit for occurrences within the same 32KB window. The dictionary approach reduces every occurrence of "the" to the same 2-byte index regardless of distance, and then zlib compresses the resulting index stream which has much shorter, denser repetition patterns.
Validation: Encode KJV Gospel of John with raw zlib and with DICT_ZLIB and compare output sizes. DICT_ZLIB should produce roughly 21KB vs raw zlib's ~31KB -- a 32% reduction. If those numbers don't match, the tokenizer or dictionary serialization has a bug.