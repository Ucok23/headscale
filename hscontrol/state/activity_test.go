package state

import (
	"testing"

	"github.com/juanfont/headscale/hscontrol/activity"
	"github.com/juanfont/headscale/hscontrol/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRecordNodeEventHandlesMissingUser(t *testing.T) {
	store, err := activity.Open(t.TempDir() + "/activity.db")
	require.NoError(t, err)

	s := &State{Activity: store}

	// A node without a user row used to panic on User().Name().
	require.NotPanics(t, func() {
		s.RecordNodeEvent("node.registered", (&types.Node{ID: 7, GivenName: "orphan"}).View(), "")
	})

	ev, err := store.Events(activity.EventFilter{})
	require.NoError(t, err)
	require.Len(t, ev, 1)
	assert.Equal(t, "orphan", ev[0].NodeName)
	assert.Empty(t, ev[0].User)
}

func TestRecordingIsNoopWithoutStore(t *testing.T) {
	var nilState *State

	assert.NotPanics(t, func() { nilState.RecordEvent("x", "y") })
	assert.NotPanics(t, func() { (&State{}).RecordNodeEvent("x", types.NodeView{}, "") })
	assert.NotPanics(t, func() { (&State{}).RecordEvent("x", "y") })
}
