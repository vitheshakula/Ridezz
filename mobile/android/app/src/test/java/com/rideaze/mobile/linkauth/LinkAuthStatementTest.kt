package com.rideaze.mobile.linkauth

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Vectors are the exact signing inputs recorded by the TypeScript protocol tests (Task 2.2). */
class LinkAuthStatementTest {

  private val nodeA = "zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0"
  private val nodeB = "aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o"
  private val transcript = "gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU"

  // linkAuthSigningInput(...) outputs recorded in __tests__/linkAuth.test.ts
  private val proofA = "{\"domain\":\"rideaze.link-auth.v1.proof\",\"v\":1,\"signer\":\"zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0\",\"peer\":\"aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o\",\"transcript\":\"gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU\"}"
  private val proofB = "{\"domain\":\"rideaze.link-auth.v1.proof\",\"v\":1,\"signer\":\"aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o\",\"peer\":\"zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0\",\"transcript\":\"gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU\"}"
  private val confirmA = "{\"domain\":\"rideaze.link-auth.v1.confirm\",\"v\":1,\"signer\":\"zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0\",\"peer\":\"aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o\",\"transcript\":\"gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU\"}"
  private val confirmB = "{\"domain\":\"rideaze.link-auth.v1.confirm\",\"v\":1,\"signer\":\"aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o\",\"peer\":\"zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0\",\"transcript\":\"gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU\"}"

  private fun statement(
    domain: String = "rideaze.link-auth.v1.proof",
    v: String = "1",
    signer: String = nodeA,
    peer: String = nodeB,
    transcript: String = this.transcript,
  ) = "{\"domain\":\"$domain\",\"v\":$v,\"signer\":\"$signer\",\"peer\":\"$peer\",\"transcript\":\"$transcript\"}"

  private fun assertRejected(label: String, stage: String, text: String, signer: String = nodeA) {
    try {
      LinkAuthStatement.validate(stage, text, signer)
      fail("accepted: $label")
    } catch (e: IllegalArgumentException) {
      assertEquals("Invalid link authentication statement", e.message)
      assertEquals(null, e.cause)
      assertFalse("message leaks input: $label", e.message!!.contains(nodeA))
    }
  }

  // ---- accepted ----------------------------------------------------------------------------

  @Test
  fun builderMatchesTheRecordedTypeScriptOutputs() {
    assertEquals(proofA, statement())
    assertEquals(confirmA, statement(domain = "rideaze.link-auth.v1.confirm"))
    assertEquals(proofB, statement(signer = nodeB, peer = nodeA))
    assertEquals(confirmB, statement(domain = "rideaze.link-auth.v1.confirm", signer = nodeB, peer = nodeA))
  }

  @Test
  fun acceptsTheRecordedProofAndConfirmStatements() {
    val p = LinkAuthStatement.validate("proof", proofA, nodeA)
    assertEquals(LinkAuthStage.PROOF, p.stage)
    assertEquals(nodeA, p.signer)
    assertEquals(nodeB, p.peer)
    assertEquals(transcript, p.transcript)
    val c = LinkAuthStatement.validate("confirm", confirmB, nodeB)
    assertEquals(LinkAuthStage.CONFIRM, c.stage)
    assertEquals(nodeB, c.signer)
    assertEquals(nodeA, c.peer)
    LinkAuthStatement.validate("proof", proofB, nodeB)
    LinkAuthStatement.validate("confirm", confirmA, nodeA)
  }

  @Test
  fun signingBytesAreTheExactUtf8StatementAndAreFreshCopies() {
    val v = LinkAuthStatement.validate("proof", proofA, nodeA)
    assertArrayEquals(proofA.toByteArray(Charsets.UTF_8), v.signingBytes())
    val first = v.signingBytes()
    first[0] = 0
    assertArrayEquals(proofA.toByteArray(Charsets.UTF_8), v.signingBytes())
    assertNotSame(v.signingBytes(), v.signingBytes())
  }

  // ---- stage, domain, version ------------------------------------------------------------------

  @Test
  fun rejectsUnknownOrMismatchedStages() {
    for (stage in listOf("", "PROOF", "Proof", "hello", "sign", "proof ", " proof", "proof\n", "confirm2")) {
      assertRejected("stage '$stage'", stage, proofA)
    }
    assertRejected("proof asked, confirm statement", "proof", confirmA)
    assertRejected("confirm asked, proof statement", "confirm", proofA)
  }

  @Test
  fun rejectsWrongDomainsAndVersions() {
    for (domain in listOf(
      "rideaze.link-auth.v1.hello", "rideaze.link-auth.v2.proof", "rideaze.link-auth.v1.transcript",
      "rideaze.link-auth.v1.PROOF", "rideaze.link-auth.v1.proof ", "rideaze.link-auth.v1.", "",
      "rideaze.credential.v1", "rideazeXlink-auth.v1.proof", "rideaze.link-auth.v1.proofconfirm",
    )) {
      assertRejected("domain '$domain'", "proof", statement(domain = domain))
    }
    for (v in listOf("0", "2", "01", "1.0", "\"1\"", "true", "null", "-1", "1e0", "")) {
      assertRejected("version $v", "proof", statement(v = v))
    }
  }

  // ---- identities --------------------------------------------------------------------------------

  @Test
  fun requiresTheSignerToBeTheExpectedLocalNode() {
    assertRejected("signer is the other node", "proof", proofA, signer = nodeB)
    assertRejected("signer is unrelated", "proof", proofA, signer = "A".repeat(43))
    assertRejected("expected signer malformed", "proof", proofA, signer = nodeA.dropLast(1))
    assertRejected("expected signer empty", "proof", proofA, signer = "")
  }

  @Test
  fun rejectsPeerEqualToSigner() {
    assertRejected("peer == signer", "proof", statement(peer = nodeA))
    assertRejected("peer == signer (confirm)", "confirm", statement(domain = "rideaze.link-auth.v1.confirm", peer = nodeA))
  }

  @Test
  fun rejectsWrongLengthIdentifiers() {
    for (bad in listOf("", nodeB.dropLast(1), nodeB + "A", nodeB.take(22), nodeB + nodeB, "A".repeat(44), "A".repeat(42))) {
      assertRejected("peer '$bad'", "proof", statement(peer = bad))
      assertRejected("transcript '$bad'", "proof", statement(transcript = bad))
      assertRejected("signer '$bad'", "proof", statement(signer = bad), signer = bad)
    }
  }

  @Test
  fun rejectsNonCanonicalOrIllegalBase64Url() {
    // last character with non-zero trailing bits: same 43 characters, different (non-canonical) text
    val nonCanonical = nodeB.dropLast(1) + "p"
    assertRejected("trailing bits (peer)", "proof", statement(peer = nonCanonical))
    assertRejected("trailing bits (transcript)", "proof", statement(transcript = transcript.dropLast(1) + "V"))
    assertRejected("padding", "proof", statement(peer = nodeB.dropLast(1) + "="))
    assertRejected("standard base64 plus", "proof", statement(peer = nodeB.replaceRange(3, 4, "+")))
    assertRejected("standard base64 slash", "proof", statement(peer = nodeB.replaceRange(3, 4, "/")))
    assertRejected("space inside", "proof", statement(peer = nodeB.replaceRange(5, 6, " ")))
    assertRejected("quote inside", "proof", statement(peer = nodeB.replaceRange(5, 6, "\"")))
    assertRejected("backslash inside", "proof", statement(peer = nodeB.replaceRange(5, 6, "\\")))
    assertRejected("non-ASCII look-alike", "proof", statement(peer = nodeB.replaceRange(0, 1, "а")))
    assertRejected("fullwidth letter", "proof", statement(peer = nodeB.replaceRange(0, 1, "ａ")))
    assertRejected("lone high surrogate", "proof", statement(peer = nodeB.replaceRange(0, 1, "\uD800")))
    assertRejected("lone low surrogate", "proof", statement(peer = nodeB.replaceRange(0, 1, "\uDC00")))
    assertRejected("NUL", "proof", statement(peer = nodeB.replaceRange(0, 1, "\u0000")))
  }

  @Test
  fun acceptsOnlyTheSixteenValidFinalCharacters() {
    val good = "AEIMQUYcgkosw048"
    for (c in good) {
      val peer = "B".repeat(42) + c
      LinkAuthStatement.validate("proof", statement(peer = peer), nodeA)
    }
    for (c in ('A'..'Z') + ('a'..'z') + ('0'..'9') + listOf('-', '_')) {
      if (c in good) continue
      assertRejected("last char $c", "proof", statement(peer = "B".repeat(42) + c))
    }
  }

  // ---- structure ----------------------------------------------------------------------------------

  @Test
  fun rejectsMissingExtraDuplicatedAndReorderedFields() {
    val d = "\"domain\":\"rideaze.link-auth.v1.proof\""
    val v = "\"v\":1"
    val s = "\"signer\":\"$nodeA\""
    val p = "\"peer\":\"$nodeB\""
    val t = "\"transcript\":\"$transcript\""
    fun obj(vararg f: String) = "{" + f.joinToString(",") + "}"
    LinkAuthStatement.validate("proof", obj(d, v, s, p, t), nodeA) // the control
    assertRejected("missing domain", "proof", obj(v, s, p, t))
    assertRejected("missing v", "proof", obj(d, s, p, t))
    assertRejected("missing signer", "proof", obj(d, v, p, t))
    assertRejected("missing peer", "proof", obj(d, v, s, t))
    assertRejected("missing transcript", "proof", obj(d, v, s, p))
    assertRejected("extra field", "proof", obj(d, v, s, p, t, "\"x\":1"))
    assertRejected("extra field first", "proof", obj("\"x\":1", d, v, s, p, t))
    assertRejected("duplicate signer", "proof", obj(d, v, s, s, p, t))
    assertRejected("duplicate transcript", "proof", obj(d, v, s, p, t, t))
    assertRejected("duplicate domain", "proof", obj(d, d, v, s, p, t))
    assertRejected("swapped signer/peer order", "proof", obj(d, v, p, s, t))
    assertRejected("v before domain", "proof", obj(v, d, s, p, t))
    assertRejected("transcript before peer", "proof", obj(d, v, s, t, p))
    assertRejected("empty object", "proof", "{}")
  }

  @Test
  fun rejectsWhitespaceNewlinesAndTrailingContent() {
    val ok = proofA
    assertRejected("trailing newline", "proof", ok + "\n")
    assertRejected("trailing space", "proof", "$ok ")
    assertRejected("leading space", "proof", " $ok")
    assertRejected("leading newline", "proof", "\n$ok")
    assertRejected("trailing CRLF", "proof", ok + "\r\n")
    assertRejected("trailing NUL", "proof", ok + "\u0000")
    assertRejected("trailing brace", "proof", "$ok}")
    assertRejected("two statements", "proof", ok + ok)
    assertRejected("space after colon", "proof", ok.replaceFirst("\"v\":1", "\"v\": 1"))
    assertRejected("space after comma", "proof", ok.replaceFirst("\",\"v\"", "\", \"v\""))
    assertRejected("pretty printed", "proof", ok.replace(",", ",\n  ").replace("{", "{\n  "))
    assertRejected("tab", "proof", ok.replaceFirst("\"v\":1", "\"v\":\t1"))
    assertRejected("escaped slash", "proof", ok.replaceFirst("link-auth", "link\\u002dauth"))
    assertRejected("unicode-escaped letter", "proof", ok.replaceFirst("\"peer\"", "\"pe\\u0065r\""))
    assertRejected("BOM prefix", "proof", "﻿" + ok)
  }

  @Test
  fun rejectsInvalidJsonAndUnrelatedFormats() {
    assertRejected("empty", "proof", "")
    assertRejected("not json", "proof", "hello")
    assertRejected("array", "proof", "[$proofA]")
    assertRejected("quoted", "proof", "\"" + proofA + "\"")
    assertRejected("truncated", "proof", proofA.dropLast(1))
    assertRejected("truncated mid-field", "proof", proofA.take(60))
    assertRejected("credential-like object", "proof", "{\"v\":1,\"kid\":\"srv-1\",\"rideId\":\"54321\",\"sessionId\":\"AAECAwQFBgcICQoLDA0ODw\",\"nodeId\":\"$nodeA\",\"pub\":\"B\",\"issuedAt\":1,\"expiresAt\":2}")
    assertRejected("credential signing text", "proof", "{\"domain\":\"rideaze.ride-credential.v1\",\"v\":1,\"signer\":\"$nodeA\",\"peer\":\"$nodeB\",\"transcript\":\"$transcript\"}")
    assertRejected("ride message", "proof", "{\"v\":1,\"type\":\"sos\",\"rideId\":\"54321\",\"originId\":\"$nodeA\"}")
    assertRejected("link-auth transcript text", "proof", "{\"domain\":\"rideaze.link-auth.v1.transcript\",\"v\":1}")
    assertRejected("plain text message", "proof", "SOS! help me at 12.3,45.6")
    assertRejected("hello payload", "proof", "{\"v\":1,\"stage\":\"hello\"}")
  }

  @Test
  fun boundsTheWorkDoneOnHugeInput() {
    assertRejected("huge", "proof", "{" + "a".repeat(5_000_000) + "}")
    assertRejected("long identifier", "proof", statement(peer = "A".repeat(100_000)))
    assertRejected("513 characters", "proof", proofA + " ".repeat(513 - proofA.length))
  }

  @Test
  fun everyTruncationAndSingleCharacterDeletionIsRejected() {
    for (len in 0 until proofA.length) assertRejected("truncated to $len", "proof", proofA.substring(0, len))
    for (i in proofA.indices) assertRejected("deleted char $i", "proof", proofA.removeRange(i, i + 1))
  }

  @Test
  fun isCanonicalIdentifierMatchesTheProtocolDefinition() {
    assertTrue(LinkAuthStatement.isCanonicalIdentifier(nodeA))
    assertTrue(LinkAuthStatement.isCanonicalIdentifier(transcript))
    assertFalse(LinkAuthStatement.isCanonicalIdentifier(nodeA.dropLast(1)))
    assertFalse(LinkAuthStatement.isCanonicalIdentifier(nodeA.dropLast(1) + "p"))
    assertFalse(LinkAuthStatement.isCanonicalIdentifier(""))
    assertFalse(LinkAuthStatement.isCanonicalIdentifier("$nodeA\n"))
  }

  @Test
  fun neverEchoesTheStatementInTheError() {
    try {
      LinkAuthStatement.validate("proof", statement(peer = nodeA), nodeA)
      fail()
    } catch (e: IllegalArgumentException) {
      assertFalse(e.message!!.contains(transcript))
      assertFalse(e.message!!.contains("signer"))
    }
  }
}
