"""Builds android/app/src/main/assets/vosk-grammar.json for VoiceHazardModule.

Vosk is given a restricted vocabulary: the hazard phrases PLUS ~1500 ordinary English words.
Without the ordinary words, Vosk forces every sentence into hazard words (5% false alerts in testing);
with them, normal speech is matched to normal words (under 1% false alerts, 98-100% hazard recall).

  pip install wordfreq vosk
  python scripts/vosk-grammar/make_grammar.py            # rewrites the asset
Run from the mobile/ folder. Only words that exist in the bundled Vosk model are used.
"""
import json, os, sys
from vosk import Model, SetLogLevel
from wordfreq import top_n_list
sys.path.insert(0, os.path.dirname(__file__))
from phrases import CATS

FILLER_WORDS = 1500
MODEL = "android/app/src/main/assets/vosk-model-small-en-us-0.15"
OUT = "android/app/src/main/assets/vosk-grammar.json"

SetLogLevel(-1)
_model = Model(MODEL)

class vocab:  # "is this word in the bundled Vosk model?"
    def __contains__(self, w):
        return _model.vosk_model_find_word(w) >= 0
vocab = vocab()
phrases, dropped, seen = [], [], set()
for _name, _rule, spoken in CATS:
    for p in spoken.split("|"):
        p = p.strip().lower()
        if not p or p in seen:
            continue
        seen.add(p)
        oov = [w for w in p.split() if w not in vocab]
        (dropped.append((p, oov)) if oov else phrases.append(p))
words = {w for p in phrases for w in p.split()}
filler = [w for w in top_n_list("en", FILLER_WORDS + 600) if w.isalpha() and len(w) > 1 and w in vocab and w not in words][:FILLER_WORDS]
grammar = phrases + filler + ["[unk]"]
with open(OUT, "w", encoding="utf8") as f:
    json.dump(grammar, f, separators=(",", ":"))
print(f"{len(phrases)} hazard phrases + {len(filler)} filler words -> {OUT} ({os.path.getsize(OUT)//1024} KB)")
if dropped:
    print("dropped (word not in the Vosk model):", dropped)
