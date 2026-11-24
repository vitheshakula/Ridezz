package com.rideaze.bench.core

import com.rideaze.bench.core.run.AcceptanceProposal
import org.junit.Assert.assertEquals
import org.junit.Test

/** The numeric proposal-v2 policy is NOT to be changed without separate approval: any edit must be a deliberate, reviewed one. */
class ProposalPinTest {
    @Test fun proposalV2NumbersAreExactlyTheApprovedOnes() {
        assertEquals("proposal-v2", AcceptanceProposal.VERSION)
        assertEquals(0.98, AcceptanceProposal.ACCEPTED_OF_GENERATED_MIN, 0.0)
        assertEquals(0.98, AcceptanceProposal.INTACT_OF_GENERATED_MIN, 0.0)
        assertEquals(0.95, AcceptanceProposal.ON_TIME_OF_GENERATED_MIN, 0.0)
        assertEquals(0.01, AcceptanceProposal.TRANSFER_FAILURE_OF_ACCEPTED_MAX, 0.0)
        assertEquals(0.001, AcceptanceProposal.CORRUPT_OF_RECEIVED_MAX, 0.0)
        assertEquals(2, AcceptanceProposal.STALLS_PER_120S_MAX)
        assertEquals(0.15, AcceptanceProposal.REPRO_CV_MAX, 0.0)
        assertEquals(false, AcceptanceProposal.toMap()["is_requirement"])
    }
}
